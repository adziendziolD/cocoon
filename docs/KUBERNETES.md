# CoCoon on Kubernetes

With `COCOON_DRIVER=kubernetes` every sandbox is a pod with its own volume. cocoond itself runs in the same cluster
(one replica), so it reaches sandbox pods directly. Plain Kubernetes and Amazon EKS are both covered; EKS only differs
in what provides the requirements below.

## What the cluster must provide

cocoond checks these at every start and refuses to start, with the reason in its log, if one is missing.

| Requirement | Why | Plain Kubernetes | Amazon EKS |
|---|---|---|---|
| A network plugin (CNI) that **enforces NetworkPolicies** | The network modes are NetworkPolicies. A pod always has a network: without enforcement even "No network" sandboxes reach every pod in the cluster | Calico or Cilium (Flannel alone ignores policies) | VPC CNI add-on with `enableNetworkPolicy: "true"` (off by default) |
| A StorageClass with **ReadWriteMany** | The agent toolbox (agent CLIs + Node.js) is one volume that every sandbox mounts read-only | NFS (e.g. nfs-subdir-external-provisioner), CephFS, Longhorn | EFS with the EFS CSI driver add-on |
| A StorageClass with **ReadWriteOnce** | One volume per sandbox (workspace, home) and one for cocoond's data | any block storage; the default class is used unless set | EBS with the EBS CSI driver add-on |
| Kubernetes **1.25 or newer** | Pod Security Admission keeps the sandbox namespace "restricted" | | |
| An **Ingress controller** with a wildcard host | UI and previews (`p<port>-<sandbox>.<domain>`); optional, `kubectl port-forward` works for a first look | e.g. ingress-nginx or Traefik | AWS Load Balancer Controller |
| **Images in a registry** the nodes can pull from | Kubernetes cannot build images | `ghcr.io/<owner>/cocoon` (cocoond) and `ghcr.io/<owner>/cocoon-sandbox` | the same, or copies in ECR |

Optional: RuntimeClasses (gVisor, Kata) can be chosen per sandbox if the cluster has them.

## Install

```bash
kubectl apply -k deploy/kubernetes/base      # plain Kubernetes
kubectl apply -k deploy/kubernetes/eks       # EKS, after replacing the REPLACE values
kubectl -n cocoon logs -f cocoon-0           # shows why it does not get ready, if it does not
kubectl -n cocoon exec cocoon-0 -- cat /data/admin-token.txt
kubectl -n cocoon port-forward svc/cocoon 7420:7420
```

The manifests create two namespaces: `cocoon` (cocoond, its data volume, a Service) and `cocoon-sandboxes` (only
sandboxes, "restricted" pod security). cocoond's rights are limited to the sandbox namespace
([`rbac.yaml`](../deploy/kubernetes/base/rbac.yaml)). Put an overlay on top of `base` for your own image, storage
classes, Ingress and a node group for sandboxes; [`deploy/kubernetes/eks`](../deploy/kubernetes/eks) and
[`tests/kubernetes`](../tests/kubernetes) are two examples.

Settings (environment of cocoond, besides the [general ones](../README.md#configuration)):

| Variable | Default | Meaning |
|---|---|---|
| `COCOON_K8S_NAMESPACE` | `cocoon-sandboxes` | Namespace of the sandboxes |
| `COCOON_K8S_TOOLBOX_STORAGE_CLASS` | cluster default | StorageClass with ReadWriteMany for the agent toolbox |
| `COCOON_K8S_STORAGE_CLASS` | cluster default | StorageClass of the sandbox volumes |
| `COCOON_K8S_WORKSPACE_SIZE` | `20Gi` | Size of a sandbox volume |
| `COCOON_K8S_SANDBOX_NODES` | – | `key=value`: sandboxes only run on nodes with this label and tolerate a `NoSchedule` taint with the same key and value |
| `COCOON_K8S_SERVICE` | `cocoon` | Name of the Service in front of cocoond |
| `COCOON_PUBLIC_URL`, `COCOON_PREVIEW_DOMAIN`, `COCOON_TRUST_PROXY=1` | – | Needed behind an Ingress, see the README |

The sandbox image is a setting (*Settings → Sandbox defaults*), seeded by the `cocoon-settings` ConfigMap on the
first start.

## Amazon EKS

[`deploy/kubernetes/eks/cluster.yaml`](../deploy/kubernetes/eks/cluster.yaml) is an eksctl template for a suitable
cluster. What it sets up, and what an existing cluster needs:

- **Two managed node groups.** `system` for cocoond and cluster services; `sandboxes` with the label and taint
  `cocoon.dev/sandbox=true`, in **one availability zone** (an EBS volume cannot follow its pod to another zone).
- **VPC CNI with NetworkPolicy** turned on, in `strict` mode so a new pod has no network before its policies apply.
- **No instance metadata for pods** on the sandbox nodes (`disablePodIMDS`), so a sandbox cannot get the node's IAM
  role. The "Open" network mode blocks `169.254.0.0/16` as well.
- **EBS and EFS CSI drivers.** Create the EFS file system yourself (mount target in the sandbox zone, NFS allowed
  from the nodes) and put its id into [`storage.yaml`](../deploy/kubernetes/eks/storage.yaml).
- **AWS Load Balancer Controller**, an ACM certificate and DNS records for `cocoon.<domain>` and
  `*.preview.<domain>` ([`ingress.yaml`](../deploy/kubernetes/eks/ingress.yaml)).

A node can only attach a limited number of EBS volumes (about 25, depending on the instance type): that is the
number of running sandboxes per node. The EKS files are templates; unlike the plain-Kubernetes path they are not
covered by the tests.

## How it differs from Docker

| | Docker / Podman | Kubernetes |
|---|---|---|
| Stop and start | the whole container file system is kept | only the volume: workspace, home (`/home/agent`) and CoCoon's files. Anything else, such as packages installed elsewhere, is gone after a stop |
| Network "No network" / "Restricted" / "Open" | no interface / internal network / bridge | NetworkPolicies: nothing / only the egress proxy / the internet without private and link-local ranges (cluster, nodes, cloud metadata, your LAN) |
| Egress proxy, port gateway | containers | processes in the cocoond pod |
| Images | built locally | pulled by the nodes; "build" in the UI reports an error |
| Process limit (`pids`) | enforced | ignored (a kubelet setting, not per pod); CPU and memory are enforced |
| Root in the sandbox for CoCoon's setup | yes | no: everything runs as user 1000, images must have that user with home `/home/agent` |
| Shared ports, managed services (databases) | yes | not yet; previews work |

## Things to know before production

- **Pin the cocoond image.** The manifests use `ghcr.io/<owner>/cocoon:latest`, which follows every merge to `main`.
  Set a commit tag (`:<7-digit commit>`) or a digest in your overlay.
- **"Open" sandboxes are kept out of `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` and
  `100.64.0.0/10`.** If your pods, Services or nodes use other addresses, open sandboxes can reach them; the start-up
  check does not notice this.
- **DNS for "Open" sandboxes** is allowed to pods labelled `k8s-app: kube-dns` in `kube-system`. With NodeLocal
  DNSCache or another DNS setup, add your own NetworkPolicy for it.
- **Another sandbox namespace** (`COCOON_K8S_NAMESPACE`) must also be put into the NetworkPolicy `cocoon` in
  [`cocoon.yaml`](../deploy/kubernetes/base/cocoon.yaml), or sandboxes cannot reach the egress proxy.
- **Who can read the sandbox namespace** sees each sandbox's environment, including its egress proxy token (API keys
  are not in there). Keep read access to `cocoon-sandboxes` as narrow as to `cocoon`.
- **Limits per sandbox:** 10 Gi of node disk outside its volume (the pod is evicted beyond that; the volume stays) and
  512 Mi for `/tmp`, which is memory and counts towards the memory limit.
- **Put the Ingress behind your own access control** where you can (VPN, IP allow-list): UI and previews are otherwise
  only protected by the login. On EKS: `alb.ingress.kubernetes.io/inbound-cidrs`.
- Tested on current Kubernetes (kind). Before 1.30 the API server speaks an older exec protocol, which is untested.

## Test setup

`pnpm test:kubernetes` (or `tests/kubernetes/setup.sh` alone) creates a three-node [kind](https://kind.sigs.k8s.io)
cluster with its own kubeconfig (`tests/kubernetes/.kubeconfig`), builds the cocoond image from the working tree,
deploys it and runs the tests through a port-forward: the Kubernetes-specific ones (network modes, node placement,
stop/start) and the backend-independent integration tests. `tests/kubernetes/setup.sh delete` removes the cluster.
