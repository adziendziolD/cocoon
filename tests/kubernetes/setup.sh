#!/usr/bin/env bash
# Creates the kind test cluster (if missing), builds and loads the images and deploys CoCoon into it.
# Needs docker, kind and kubectl. The cluster gets its own kubeconfig, yours is not touched.
#   tests/kubernetes/setup.sh           # create or update
#   tests/kubernetes/setup.sh delete    # remove the cluster
set -euo pipefail
cd "$(dirname "$0")/../.."
CLUSTER=cocoon-test
export KUBECONFIG="$PWD/tests/kubernetes/.kubeconfig"

if [ "${1:-}" = delete ]; then
  kind delete cluster --name "$CLUSTER"
  exit
fi

kind get clusters 2>/dev/null | grep -qx "$CLUSTER" || kind create cluster --name "$CLUSTER" --config tests/kubernetes/kind.yaml
kind export kubeconfig --name "$CLUSTER"

docker build -q -f deploy/kubernetes/Dockerfile -t cocoon/cocoond:test .
docker image inspect cocoon/sandbox:latest >/dev/null 2>&1 || docker build -q -t cocoon/sandbox:latest images/sandbox
# The toolbox installer image (node) is pulled by the nodes themselves.
kind load docker-image --name "$CLUSTER" cocoon/cocoond:test cocoon/sandbox:latest

# Sandboxes only on their node, and nothing else there.
SANDBOX_NODE=$(kubectl get nodes -l cocoon.dev/sandbox=true -o jsonpath='{.items[0].metadata.name}')
kubectl taint node "$SANDBOX_NODE" cocoon.dev/sandbox=true:NoSchedule --overwrite
docker exec "$SANDBOX_NODE" sh -c 'mkdir -p /var/cocoon-toolbox && chown 1000:1000 /var/cocoon-toolbox'

kubectl apply -k tests/kubernetes
# Same image tag as before: only a restart picks up the new build.
kubectl -n cocoon rollout restart statefulset/cocoon
kubectl -n cocoon rollout status statefulset/cocoon --timeout=300s || { kubectl -n cocoon logs statefulset/cocoon --tail=50; exit 1; }
