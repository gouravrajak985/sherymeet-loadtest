#!/bin/bash
set -e

# Configuration
# Region: "auto" picks the first region in REGION_PREFERENCE that is enabled,
# offers INSTANCE_TYPE and has enough free On-Demand vCPU quota for the cluster.
# Hyderabad (ap-south-2) is last on purpose: the SFU servers under test run there,
# and load generators would eat the vCPU quota the SFU needs to scale out.
REGION="${LOADTEST_REGION:-auto}"
REGION_PREFERENCE="${LOADTEST_REGION_PREFERENCE:-ap-south-1 ap-southeast-1 ap-south-2}"
SUBNET_ID="${LOADTEST_SUBNET_ID:-}"      # empty = auto-discover public subnets in REGION
INSTANCE_TYPE="m6i.8xlarge"
INSTANCE_COUNT=4
SG_NAME="sherymeet-loadtest-sg"
REPO_URL="https://github.com/gouravrajak985/sherymeet-loadtest.git"
INSTANCES_FILE="loadtest-instances.txt"
REGION_FILE="loadtest-region.txt"        # region the current cluster was deployed to
AMI_PARAM="/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

usage() {
    cat <<EOF
${BLUE}SheryMeet Load Test Cluster Manager${NC}

Usage: $0 <command> [options]

Commands:
  deploy              Launch EC2 instances and set up load test environment
  run [meeting-url]   Run load test on all instances (prompts for URL if not provided)
  status              Show status of all instances
  ssh <instance-num>  SSH into a specific instance (1-4)
  logs                Download logs and reports from all instances
  watch               Stream live logs from all instances combined
  cleanup             Terminate all instances and clean up resources

Options:
  -r, --region <name> AWS region, or "auto" (default: auto = nearest region with
                      free vCPU quota, in order: $REGION_PREFERENCE)
  -s, --subnet <id>   Public subnet to launch in (default: auto-discover)
  -n, --count <num>   Number of instances (default: 4)
  -t, --type <type>   Instance type (default: m6i.8xlarge)
  -p, --participants  Participants per instance (default: 200)
  -d, --duration      Test duration in minutes (default: 10)
  -h, --help          Show this help

Examples:
  $0 deploy
  $0 deploy --region ap-south-1 --count 6
  $0 run https://sherymeet.pugly.in/meet/my-room
  $0 status
  $0 ssh 1
  $0 cleanup

EOF
    exit 0
}

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Key pairs are per region, so the key (and its .pem) is named per region.
set_region_vars() {
    KEY_NAME="sherymeet-loadtest-key-$REGION"
}

# Region of the deployed cluster (status/run/ssh/logs/watch/cleanup)
load_deployed_region() {
    if [ -f "$REGION_FILE" ]; then
        REGION=$(cat "$REGION_FILE")
    elif [ "$REGION" = "auto" ]; then
        REGION="ap-south-2"   # clusters deployed before regions were recorded
    fi
    set_region_vars
}

# Free standard On-Demand vCPU (A,C,D,H,I,M,R,T,Z families) in a region
free_vcpus() {
    local region="$1" quota types vmap used=0
    quota=$(aws service-quotas get-service-quota --region "$region" --service-code ec2 \
        --quota-code L-1216C47A --query 'Quota.Value' --output text 2>/dev/null) || return 1
    types=$(aws ec2 describe-instances --region "$region" \
        --filters "Name=instance-state-name,Values=pending,running" \
        --query 'Reservations[].Instances[?InstanceLifecycle==`null`].InstanceType[]' --output json 2>/dev/null)
    if [ "$(echo "$types" | jq 'length')" -gt 0 ]; then
        # shellcheck disable=SC2046
        vmap=$(aws ec2 describe-instance-types --region "$region" \
            --instance-types $(echo "$types" | jq -r 'unique[]') \
            --query 'InstanceTypes[].{t:InstanceType,v:VCpuInfo.DefaultVCpus}' --output json)
        used=$(jq -n --argjson ts "$types" --argjson vm "$vmap" \
            '($vm | map({(.t): .v}) | add) as $m | [$ts[] | select(test("^[acdhimrtz]")) | $m[.]] | add // 0')
    fi
    echo $(( ${quota%.*} - used ))
}

instance_vcpus() {
    aws ec2 describe-instance-types --region "$1" --instance-types "$INSTANCE_TYPE" \
        --query 'InstanceTypes[0].VCpuInfo.DefaultVCpus' --output text 2>/dev/null
}

region_enabled() {
    local s
    s=$(aws ec2 describe-regions --all-regions --region us-east-1 \
        --filters "Name=region-name,Values=$1" --query 'Regions[0].OptInStatus' --output text 2>/dev/null)
    [ "$s" = "opt-in-not-required" ] || [ "$s" = "opted-in" ]
}

# Picks REGION (if "auto") and checks the cluster fits its vCPU quota
choose_region() {
    local per need free r
    if [ "$REGION" != "auto" ]; then
        region_enabled "$REGION" || { log_error "Region $REGION is not enabled for this account"; exit 1; }
        per=$(instance_vcpus "$REGION")
        [ -n "$per" ] && [ "$per" != "None" ] || { log_error "$INSTANCE_TYPE is not offered in $REGION"; exit 1; }
        need=$(( per * INSTANCE_COUNT )); free=$(free_vcpus "$REGION")
        if [ "$free" -lt "$need" ]; then
            log_error "$REGION has $free vCPU free; $INSTANCE_COUNT x $INSTANCE_TYPE needs $need. Use --region auto, fewer --count, or a smaller --type."
            exit 1
        fi
        log_success "Region $REGION: $free vCPU free, cluster needs $need"
        set_region_vars
        return
    fi
    log_info "Choosing region (preference: $REGION_PREFERENCE)..."
    for r in $REGION_PREFERENCE; do
        if ! region_enabled "$r"; then log_warn "$r: not enabled"; continue; fi
        per=$(instance_vcpus "$r")
        if [ -z "$per" ] || [ "$per" = "None" ]; then log_warn "$r: $INSTANCE_TYPE not offered"; continue; fi
        need=$(( per * INSTANCE_COUNT )); free=$(free_vcpus "$r" || echo 0)
        if [ "$free" -ge "$need" ]; then
            REGION="$r"
            log_success "Using $REGION: $free vCPU free, cluster needs $need"
            set_region_vars
            return
        fi
        log_warn "$r: only $free vCPU free, need $need"
    done
    log_error "No region in '$REGION_PREFERENCE' has $INSTANCE_COUNT x $INSTANCE_TYPE free. Lower --count or request a quota increase."
    exit 1
}

# Finds public subnets (default route to an internet gateway + public IPs on
# launch; the nodes need public IPs for SSH and outbound traffic). Picks the VPC
# whose public subnets cover the most Availability Zones, so a capacity shortage
# in one zone can fall back to another. Sets VPC_ID, SUBNET_ID, SUBNET_CANDIDATES.
choose_subnet() {
    if [ -n "$SUBNET_ID" ]; then
        VPC_ID=$(aws ec2 describe-subnets --region "$REGION" --subnet-ids "$SUBNET_ID" \
            --query 'Subnets[0].VpcId' --output text 2>/dev/null) \
            || { log_error "Subnet $SUBNET_ID not found in $REGION"; exit 1; }
        SUBNET_CANDIDATES="$SUBNET_ID"
        log_success "Subnet $SUBNET_ID (VPC $VPC_ID)"
        return
    fi
    local rts rows
    rts=$(aws ec2 describe-route-tables --region "$REGION" --output json)
    # Rows: free-IPs subnet vpc az name
    rows=$(aws ec2 describe-subnets --region "$REGION" \
        --filters "Name=map-public-ip-on-launch,Values=true" "Name=state,Values=available" --output json \
      | jq -r --argjson rts "$rts" '
          ($rts.RouteTables) as $t
          | .Subnets[]
          | . as $s
          | ([$t[] | select(any(.Associations[]?; .SubnetId == $s.SubnetId))][0]
             // [$t[] | select(.VpcId == $s.VpcId and any(.Associations[]?; .Main == true))][0]) as $rt
          | select($rt != null and any($rt.Routes[]?; .DestinationCidrBlock == "0.0.0.0/0" and ((.GatewayId // "") | startswith("igw-"))))
          | [.AvailableIpAddressCount, .SubnetId, .VpcId, .AvailabilityZone,
             ((.Tags // []) | map(select(.Key == "Name").Value) | first // "-")] | @tsv')
    [ -n "$rows" ] || { log_error "No public subnet (internet gateway route + public IPs) in $REGION. Pass --subnet <id>."; exit 1; }
    # VPC with the most zones; tie-break on free IPs
    VPC_ID=$(echo "$rows" | awk -F'\t' '{ k = $3 SUBSEP $4; if (!(k in seen)) { seen[k] = 1; az[$3]++ } ip[$3] += $1 }
        END { for (v in az) printf "%d\t%d\t%s\n", az[v], ip[v], v }' | sort -k1,1nr -k2,2nr | head -1 | cut -f3)
    # One subnet per zone (the one with the most free IPs), in zone order
    SUBNET_CANDIDATES=$(echo "$rows" | awk -F'\t' -v v="$VPC_ID" '$3 == v' | sort -t$'\t' -k4,4 -k1,1nr \
        | awk -F'\t' '!seen[$4]++ { print $2 }' | tr '\n' ' ')
    SUBNET_ID="${SUBNET_CANDIDATES%% *}"
    log_success "VPC $VPC_ID, public subnets in $(echo "$rows" | awk -F'\t' -v v="$VPC_ID" '$3 == v { print $4 }' | sort -u | tr '\n' ' ')"
    log_info "Launch order (next zone is tried if one has no capacity): $SUBNET_CANDIDATES"
}

get_instance_ips() {
    load_deployed_region
    if [ ! -f "$INSTANCES_FILE" ]; then
        log_error "No instances file found. Run 'deploy' first."
        exit 1
    fi
    INSTANCE_IDS=$(cat "$INSTANCES_FILE")
    IPS=()
    for id in $INSTANCE_IDS; do
        IP=$(aws ec2 describe-instances --instance-ids "$id" --region "$REGION" \
            --query 'Reservations[0].Instances[0].PublicIpAddress' --output text 2>/dev/null)
        if [ "$IP" != "None" ] && [ -n "$IP" ]; then
            IPS+=("$IP")
        fi
    done
}

prompt_meeting_url() {
    echo ""
    echo -e "${BLUE}Enter the SheryMeet meeting URL to load test:${NC}"
    echo -e "${YELLOW}Example: https://sherymeet.pugly.in/meet/your-room-id${NC}"
    echo ""
    read -p "Meeting URL: " MEETING_URL

    if [ -z "$MEETING_URL" ]; then
        log_error "Meeting URL is required"
        exit 1
    fi

    # Strict URL validation to prevent command injection
    if [[ ! "$MEETING_URL" =~ ^https://[a-zA-Z0-9._-]+/[a-zA-Z0-9./_-]+$ ]]; then
        log_error "Invalid URL format. URL must only contain alphanumeric characters, dots, dashes, underscores, and slashes."
        exit 1
    fi

    # Validate expected domain
    if [[ ! "$MEETING_URL" =~ ^https://sherymeet\.pugly\.in/meet/ ]]; then
        log_warn "URL doesn't match expected format (https://sherymeet.pugly.in/meet/...)"
        read -p "Continue anyway? (y/n) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi

    echo ""
    log_info "Meeting URL: $MEETING_URL"
}

cmd_deploy() {
    echo ""
    echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║       SheryMeet Load Test Cluster - Deploy                   ║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    if [ -f "$INSTANCES_FILE" ]; then
        log_error "A cluster is already deployed in $(cat "$REGION_FILE" 2>/dev/null || echo ap-south-2) ($INSTANCES_FILE). Run '$0 cleanup' first."
        exit 1
    fi

    # Prompt for meeting URL first
    prompt_meeting_url

    echo ""
    choose_region
    choose_subnet
    AMI_ID=$(aws ssm get-parameter --region "$REGION" --name "$AMI_PARAM" --query Parameter.Value --output text)
    log_success "AMI $AMI_ID (Amazon Linux 2023)"

    echo ""
    echo -e "${YELLOW}Deployment Configuration:${NC}"
    echo "  Region:           $REGION"
    echo "  VPC / Subnets:    $VPC_ID / $SUBNET_CANDIDATES"
    echo "  Instance Type:    $INSTANCE_TYPE"
    echo "  Instance Count:   $INSTANCE_COUNT"
    echo "  Participants:     ${PARTICIPANTS_PER_INSTANCE:-200} per instance ($((INSTANCE_COUNT * PARTICIPANTS_PER_INSTANCE)) total)"
    echo "  Test Duration:    ${TEST_DURATION:-10} minutes"
    echo "  Meeting URL:      $MEETING_URL"
    echo ""
    echo -e "${YELLOW}Estimated Cost: ~\$$(echo "$INSTANCE_COUNT * 1.54" | bc)/hour${NC}"
    echo ""

    read -p "Proceed with deployment? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Cancelled"
        exit 0
    fi

    echo ""

    # Create key pair
    log_info "Checking key pair..."
    if ! aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$REGION" &>/dev/null; then
        log_info "Creating key pair: $KEY_NAME"
        aws ec2 create-key-pair \
            --key-name "$KEY_NAME" \
            --region "$REGION" \
            --query 'KeyMaterial' \
            --output text > "${KEY_NAME}.pem"
        chmod 400 "${KEY_NAME}.pem"
        log_success "Key saved to ${KEY_NAME}.pem"
    else
        log_success "Key pair exists"
    fi

    # Create security group
    log_info "Checking security group..."
    SG_ID=$(aws ec2 describe-security-groups \
        --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
        --region "$REGION" \
        --query 'SecurityGroups[0].GroupId' \
        --output text 2>/dev/null || echo "None")

    if [ "$SG_ID" == "None" ] || [ -z "$SG_ID" ]; then
        log_info "Creating security group: $SG_NAME"
        SG_ID=$(aws ec2 create-security-group \
            --group-name "$SG_NAME" \
            --description "Security group for SheryMeet load testing" \
            --vpc-id "$VPC_ID" \
            --region "$REGION" \
            --query 'GroupId' \
            --output text)

        aws ec2 authorize-security-group-ingress \
            --group-id "$SG_ID" \
            --protocol tcp \
            --port 22 \
            --cidr 0.0.0.0/0 \
            --region "$REGION" > /dev/null

        log_success "Security group created: $SG_ID"
    else
        log_success "Security group exists: $SG_ID"
    fi

    # Generate user data with the meeting URL
    PARTICIPANTS=${PARTICIPANTS_PER_INSTANCE:-200}
    DURATION=${TEST_DURATION:-10}

    USER_DATA=$(cat <<USERDATA
#!/bin/bash
set -ex
exec > >(tee /var/log/loadtest-setup.log) 2>&1

echo "=== Starting load test setup ==="
cd /home/ec2-user

# Install Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
yum install -y nodejs git

# Install Playwright dependencies
yum install -y \
    alsa-lib atk cups-libs gtk3 libXcomposite libXdamage libXrandr \
    libgbm libxkbcommon nss pango xorg-x11-fonts-100dpi xorg-x11-fonts-75dpi \
    xorg-x11-fonts-Type1 xorg-x11-fonts-misc xorg-x11-utils libdrm mesa-libgbm

# Clone repo
sudo -u ec2-user git clone $REPO_URL
cd sherymeet-loadtest

# Create .env
cat > .env <<'ENV'
LOADTEST_ALLOWED_HOSTS=sherymeet.pugly.in
LOADTEST_PRODUCTION_HARD_MAX=1000
LOG_LEVEL=info
ENV

# Install deps
sudo -u ec2-user npm install
sudo -u ec2-user npx playwright install chromium

# Create test config with the specified meeting URL
cat > configs/cluster-test.json <<CONFIG
{
  "name": "Cluster Load Test - $PARTICIPANTS participants",
  "target": {
    "meetingUrl": "$MEETING_URL",
    "environment": "production"
  },
  "participants": {
    "total": $PARTICIPANTS,
    "publishers": 0,
    "subscribers": $PARTICIPANTS,
    "cameraPublishers": 0,
    "microphonePublishers": 0,
    "interactiveSubscriberRatio": 0.3
  },
  "execution": {
    "durationMinutes": $DURATION,
    "rampUpSeconds": 120,
    "rampDownSeconds": 60,
    "maxBrowsersPerWorker": $PARTICIPANTS
  }
}
CONFIG

chown -R ec2-user:ec2-user /home/ec2-user/sherymeet-loadtest
touch /home/ec2-user/setup-complete
echo "=== Setup complete ==="
USERDATA
)

    # Launch instances; if a zone has no capacity for the type, try the next zone
    INSTANCE_IDS=""
    for SN in $SUBNET_CANDIDATES; do
        AZ=$(aws ec2 describe-subnets --region "$REGION" --subnet-ids "$SN" \
            --query 'Subnets[0].AvailabilityZone' --output text)
        log_info "Launching $INSTANCE_COUNT x $INSTANCE_TYPE in $AZ ($SN)..."
        if OUT=$(aws ec2 run-instances \
            --image-id "$AMI_ID" \
            --instance-type "$INSTANCE_TYPE" \
            --key-name "$KEY_NAME" \
            --security-group-ids "$SG_ID" \
            --subnet-id "$SN" \
            --count "$INSTANCE_COUNT" \
            --user-data "$USER_DATA" \
            --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=sherymeet-loadtest},{Key=Project,Value=sherymeet-loadtest}]" \
            --region "$REGION" \
            --query 'Instances[*].InstanceId' \
            --output text 2>&1); then
            INSTANCE_IDS="$OUT"
            SUBNET_ID="$SN"
            break
        elif echo "$OUT" | grep -qE "InsufficientInstanceCapacity|Unsupported"; then
            log_warn "No $INSTANCE_TYPE capacity in $AZ right now; trying the next zone"
        else
            log_error "Launch failed: $OUT"
            exit 1
        fi
    done
    if [ -z "$INSTANCE_IDS" ]; then
        log_error "No zone in $REGION had capacity for $INSTANCE_COUNT x $INSTANCE_TYPE. Try --region ap-southeast-1, a smaller --count, or another --type (e.g. c6i.8xlarge, m7i.8xlarge)."
        exit 1
    fi

    echo "$INSTANCE_IDS" > "$INSTANCES_FILE"
    echo "$REGION" > "$REGION_FILE"
    log_success "Launched: $INSTANCE_IDS"

    # Wait for running
    log_info "Waiting for instances to start..."
    aws ec2 wait instance-running --instance-ids $INSTANCE_IDS --region "$REGION"
    log_success "All instances running"

    # Show status
    echo ""
    cmd_status

    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                    Deployment Complete!                      ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "Wait ~5 minutes for setup to complete, then run:"
    echo ""
    echo -e "  ${YELLOW}$0 status${NC}      # Check if instances are ready"
    echo -e "  ${YELLOW}$0 run${NC}         # Start the load test"
    echo ""
}

cmd_status() {
    load_deployed_region
    if [ ! -f "$INSTANCES_FILE" ]; then
        log_error "No instances deployed. Run '$0 deploy' first."
        exit 1
    fi

    INSTANCE_IDS=$(cat "$INSTANCES_FILE")

    echo ""
    echo -e "${BLUE}Instance Status (${REGION}):${NC}"
    echo ""

    i=1
    for id in $INSTANCE_IDS; do
        INFO=$(aws ec2 describe-instances --instance-ids "$id" --region "$REGION" \
            --query 'Reservations[0].Instances[0].[PublicIpAddress,State.Name]' --output text 2>/dev/null)
        IP=$(echo "$INFO" | awk '{print $1}')
        STATE=$(echo "$INFO" | awk '{print $2}')

        # Check setup status
        SETUP_STATUS="pending"
        if [ "$STATE" == "running" ] && [ "$IP" != "None" ]; then
            if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 -o BatchMode=yes \
                -i "${KEY_NAME}.pem" ec2-user@"$IP" "test -f /home/ec2-user/setup-complete" 2>/dev/null; then
                SETUP_STATUS="${GREEN}ready${NC}"
            else
                SETUP_STATUS="${YELLOW}setting up${NC}"
            fi
        fi

        printf "  [%d] %-20s %-12s %b\n" "$i" "$IP" "$STATE" "$SETUP_STATUS"
        ((i++))
    done
    echo ""
}

validate_url() {
    local url="$1"
    if [[ ! "$url" =~ ^https://[a-zA-Z0-9._-]+/[a-zA-Z0-9./_-]+$ ]]; then
        log_error "Invalid URL format. URL must only contain alphanumeric characters, dots, dashes, underscores, and slashes."
        exit 1
    fi
}

cmd_run() {
    MEETING_URL="$1"

    if [ -z "$MEETING_URL" ]; then
        prompt_meeting_url
    else
        validate_url "$MEETING_URL"
    fi

    get_instance_ips

    if [ ${#IPS[@]} -eq 0 ]; then
        log_error "No running instances found"
        exit 1
    fi

    echo ""
    echo -e "${BLUE}Starting load test on ${#IPS[@]} instances${NC}"
    echo "Meeting URL: $MEETING_URL"
    echo ""

    # Check readiness
    NOT_READY=0
    for IP in "${IPS[@]}"; do
        if ! ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 -o BatchMode=yes \
            -i "${KEY_NAME}.pem" ec2-user@"$IP" "test -f /home/ec2-user/setup-complete" 2>/dev/null; then
            log_warn "$IP is still setting up"
            NOT_READY=$((NOT_READY + 1))
        fi
    done

    if [ $NOT_READY -gt 0 ]; then
        read -p "Some instances aren't ready. Continue anyway? (y/n) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi

    # Extract host for confirm flag
    HOST=$(echo "$MEETING_URL" | sed -E 's|https?://([^/]+).*|\1|')

    # Start tests
    echo ""
    log_info "Starting tests..."
    PIDS=()
    LOGS=()

    for i in "${!IPS[@]}"; do
        IP="${IPS[$i]}"
        LOG="loadtest-node-$((i+1)).log"
        LOGS+=("$LOG")

        log_info "Starting on $IP (log: $LOG)"

        CONFIG_JSON=$(cat <<CONFIG
{
  "name": "Cluster Load Test - node $((i+1)) - $PARTICIPANTS_PER_INSTANCE participants",
  "target": { "meetingUrl": "$MEETING_URL", "environment": "production" },
  "participants": {
    "total": $PARTICIPANTS_PER_INSTANCE,
    "publishers": 0,
    "subscribers": $PARTICIPANTS_PER_INSTANCE,
    "cameraPublishers": 0,
    "microphonePublishers": 0,
    "interactiveSubscriberRatio": 0.3,
    "namePrefix": "LoadBot-N$((i+1))"
  },
  "execution": {
    "durationMinutes": $TEST_DURATION,
    "rampUpSeconds": 120,
    "rampDownSeconds": 60,
    "maxBrowsersPerWorker": $PARTICIPANTS_PER_INSTANCE
  }
}
CONFIG
)
        # Config goes over stdin so the remote side never interprets it
        printf '%s\n' "$CONFIG_JSON" | ssh -o StrictHostKeyChecking=no -i "${KEY_NAME}.pem" ec2-user@"$IP" \
            "cd /home/ec2-user/sherymeet-loadtest && \
             cat > configs/cluster-test.json && \
             npm run run-test -- --config configs/cluster-test.json --confirm-production $HOST --skip-resource-guard" \
            > "$LOG" 2>&1 &
        PIDS+=($!)
    done

    echo ""
    log_info "Tests running on ${#PIDS[@]} instances"
    echo ""
    echo "Monitor options:"
    echo "  - Local logs:    tail -f ${LOGS[0]}"
    echo "  - Combined live: $0 watch  (in another terminal)"
    echo ""
    echo "Waiting for tests to complete..."

    # Wait for completion
    FAILED=0
    for i in "${!PIDS[@]}"; do
        if wait "${PIDS[$i]}"; then
            log_success "Node $((i+1)) (${IPS[$i]}): PASSED"
        else
            log_error "Node $((i+1)) (${IPS[$i]}): FAILED (see ${LOGS[$i]})"
            FAILED=$((FAILED + 1))
        fi
    done

    echo ""
    echo -e "${BLUE}Results: $((${#PIDS[@]} - FAILED))/${#PIDS[@]} passed${NC}"

    # Download reports
    cmd_logs
}

cmd_ssh() {
    NUM="${1:-1}"
    get_instance_ips

    INDEX=$((NUM - 1))
    if [ $INDEX -lt 0 ] || [ $INDEX -ge ${#IPS[@]} ]; then
        log_error "Invalid instance number. Choose 1-${#IPS[@]}"
        exit 1
    fi

    IP="${IPS[$INDEX]}"
    log_info "Connecting to instance $NUM ($IP)..."
    ssh -o StrictHostKeyChecking=no -i "${KEY_NAME}.pem" ec2-user@"$IP"
}

cmd_logs() {
    get_instance_ips

    log_info "Downloading logs and reports..."
    mkdir -p reports/cluster

    for i in "${!IPS[@]}"; do
        IP="${IPS[$i]}"
        DIR="reports/cluster/node-$((i+1))"
        mkdir -p "$DIR"

        log_info "Downloading from $IP..."
        scp -o StrictHostKeyChecking=no -i "${KEY_NAME}.pem" -r \
            ec2-user@"$IP":/home/ec2-user/sherymeet-loadtest/reports/* \
            "$DIR/" 2>/dev/null || log_warn "No reports on $IP"

        scp -o StrictHostKeyChecking=no -i "${KEY_NAME}.pem" \
            ec2-user@"$IP":/var/log/loadtest-setup.log \
            "$DIR/setup.log" 2>/dev/null || true
    done

    log_success "Reports saved to reports/cluster/"
}

cmd_watch() {
    # `run` streams each node's test output into loadtest-node-N.log on this machine
    shopt -s nullglob
    LOG_FILES=(loadtest-node-*.log)
    shopt -u nullglob
    if [ ${#LOG_FILES[@]} -eq 0 ]; then
        log_error "No loadtest-node-*.log files here. Start '$0 run' first (from this directory)."
        exit 1
    fi

    echo ""
    echo -e "${BLUE}Live test logs from ${#LOG_FILES[@]} nodes (Ctrl+C to stop watching; the test keeps running)${NC}"
    echo ""

    trap 'kill $(jobs -p) 2>/dev/null' EXIT INT TERM

    COLORS=("\033[0;32m" "\033[0;33m" "\033[0;36m" "\033[0;35m" "\033[0;34m")
    for f in "${LOG_FILES[@]}"; do
        NODE="${f#loadtest-node-}"
        NODE="${NODE%.log}"
        COLOR="${COLORS[$(( (NODE - 1) % ${#COLORS[@]} ))]}"
        tail -n 20 -F "$f" 2>/dev/null | \
            awk -v p="${COLOR}[Node ${NODE}]${NC} " '{ print p $0; fflush() }' &
    done

    wait
}

cmd_cleanup() {
    echo ""
    echo -e "${RED}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║                    Cleanup Resources                         ║${NC}"
    echo -e "${RED}╚══════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    load_deployed_region
    echo "Region: $REGION"

    if [ -f "$INSTANCES_FILE" ]; then
        INSTANCE_IDS=$(cat "$INSTANCES_FILE")
        echo "Instances to terminate: $INSTANCE_IDS"
    else
        echo "No instances file found"
    fi

    echo ""
    read -p "Are you sure you want to terminate all resources? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Cancelled"
        exit 0
    fi

    # Terminate instances
    if [ -f "$INSTANCES_FILE" ]; then
        INSTANCE_IDS=$(cat "$INSTANCES_FILE")
        log_info "Terminating instances..."
        aws ec2 terminate-instances --instance-ids $INSTANCE_IDS --region "$REGION" &>/dev/null || true

        log_info "Waiting for termination..."
        aws ec2 wait instance-terminated --instance-ids $INSTANCE_IDS --region "$REGION" 2>/dev/null || true

        rm -f "$INSTANCES_FILE" "$REGION_FILE"
        log_success "Instances terminated"
    fi

    # Delete security groups (one per VPC the cluster was ever deployed to)
    log_info "Deleting security groups..."
    SG_IDS=$(aws ec2 describe-security-groups \
        --filters "Name=group-name,Values=$SG_NAME" \
        --region "$REGION" \
        --query 'SecurityGroups[].GroupId' \
        --output text 2>/dev/null || echo "")
    for SG_ID in $SG_IDS; do
        if aws ec2 delete-security-group --group-id "$SG_ID" --region "$REGION" 2>/dev/null; then
            log_success "Security group $SG_ID deleted"
        else
            log_warn "Could not delete $SG_ID (still in use?)"
        fi
    done

    # Key pair
    read -p "Delete key pair and .pem file? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        aws ec2 delete-key-pair --key-name "$KEY_NAME" --region "$REGION" 2>/dev/null || true
        rm -f "${KEY_NAME}.pem"
        log_success "Key pair deleted"
    fi

    echo ""
    log_success "Cleanup complete"
}

# Parse options (they may come before or after the command)
ARGS=()
PARTICIPANTS_PER_INSTANCE=200
TEST_DURATION=10

while [[ $# -gt 0 ]]; do
    case $1 in
        -r|--region)
            REGION="$2"
            shift 2
            ;;
        -s|--subnet)
            SUBNET_ID="$2"
            shift 2
            ;;
        -n|--count)
            INSTANCE_COUNT="$2"
            shift 2
            ;;
        -t|--type)
            INSTANCE_TYPE="$2"
            shift 2
            ;;
        -p|--participants)
            PARTICIPANTS_PER_INSTANCE="$2"
            shift 2
            ;;
        -d|--duration)
            TEST_DURATION="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        deploy|run|status|ssh|logs|watch|cleanup)
            if [ -z "${COMMAND:-}" ]; then COMMAND="$1"; else ARGS+=("$1"); fi
            shift
            ;;
        -*)
            log_error "Unknown option: $1"
            usage
            ;;
        *)
            # positional argument for the command (meeting URL, instance number)
            ARGS+=("$1")
            shift
            ;;
    esac
done

# Tool schema caps one machine at 200 browsers (src/config/schema.ts)
if ! [[ "$PARTICIPANTS_PER_INSTANCE" =~ ^[0-9]+$ ]] || [ "$PARTICIPANTS_PER_INSTANCE" -lt 3 ] || [ "$PARTICIPANTS_PER_INSTANCE" -gt 200 ]; then
    log_error "--participants must be between 3 and 200 per instance"
    exit 1
fi
if ! [[ "$TEST_DURATION" =~ ^[0-9]+$ ]]; then
    log_error "--duration must be a whole number of minutes"
    exit 1
fi


case "${COMMAND:-}" in
    deploy)
        cmd_deploy
        ;;
    run)
        cmd_run "${ARGS[0]:-}"
        ;;
    status)
        cmd_status
        ;;
    ssh)
        cmd_ssh "${ARGS[0]:-1}"
        ;;
    logs)
        cmd_logs
        ;;
    watch)
        cmd_watch
        ;;
    cleanup)
        cmd_cleanup
        ;;
    *)
        usage
        ;;
esac
