project_id = "toku-agents"
region     = "us-central1"

# Owned by TGA's infra/agents, and only looked up here.
subnetwork  = "agents-us-central1"
network_tag = "agent-vm"

# Where the VMs reach Wilson, over the tailnet.
wilson_url = "http://tower:13101"

# May sign in to the VMs, and so read the tokens on them. Nobody else can.
wilson_operators = ["user:robert@toku.com"]
