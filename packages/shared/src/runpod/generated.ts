// GENERATED FILE — do not edit by hand.
// Source: https://api.runpod.io/v2/openapi.json
// Regenerate with: npm run gen:runpod
// Spec version: 2.0.0
/* eslint-disable */

/** Catalog stock availability level. */
export type AvailabilityLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH"

/** Container configuration universal to every containerized resource. Compose ContainerConfig instead unless the resource cannot support private registries (clusters, until the upstream input accepts a registry credential). */
export type BaseContainerConfig = {
  /** Arguments passed to the container entrypoint */
  "args"?: string
  /** Container disk in GB (ephemeral, wiped on restart) */
  "disk"?: number
  /** Environment variables as key-value pairs */
  "env"?: Record<string, string>
  /** Docker image reference */
  "image"?: string
  /** Exposed ports, formatted as port/protocol */
  "ports"?: Array<string>
}

export type BaseCpuConfig = {
  /** CPU flavor identifier, as returned by GET /v2/catalog/cpus. */
  "id": string
  /** Number of vCPUs. Must be valid for the selected CPU flavor and must be a power of two. */
  "vcpuCount": number
}

/** Half-open time range [startTime, endTime) in RFC 3339. On a record it is the time bucket; on a query echo it is the resolved window. */
export type BillingTimeRange = {
  /** Start of the range, inclusive (RFC 3339). */
  "startTime": string
  /** End of the range, exclusive (RFC 3339). */
  "endTime": string
}

export type CatalogResourceAvailability = {
  /** Catalog resource identifier. */
  "id": string
  /** Human-readable catalog resource name. */
  "name": string
  "availability": AvailabilityLevel
}

/** Cloud tier. */
export type Cloud = "SECURE" | "COMMUNITY"

/** Compliance certifications. */
export type Compliance = "GDPR" | "ISO_IEC_27001" | "ISO_14001" | "PCI_DSS" | "HITRUST" | "SOC_1_TYPE_2" | "SOC_2_TYPE_2" | "SOC_3_TYPE_2" | "ITAR" | "FISMA_HIGH" | "HIPAA" | "RENEWABLE"

/** Reusable container configuration shared across templates, pods, and serverless endpoints. Adding a field here automatically propagates to all three resources. */
export type ContainerConfig = BaseContainerConfig & {
  /** Container registry credential ID (for private images) */
  "registry"?: string | null
}

export type CpuConfig = BaseCpuConfig & {
  /** Memory allocated to the pod in GB. */
  "memory": number
}

export type CreateCpuConfig = BaseCpuConfig

/** GPU request for a pod create. Carries the CUDA host constraints, which */
export type CreateGpuConfig = GpuConfig & {
  /** Acceptable CUDA versions for the host machine, as `major.minor`. */
  "allowedCudaVersions"?: Array<string>
  /** Lowest acceptable CUDA version for the host machine, as */
  "minCudaVersion"?: string
}

export type CreateNetworkVolumeRequest = {
  /** Data center in which to create the volume */
  "dataCenter": string
  /** Human-readable name */
  "name": string
  /** Storage to allocate in GB */
  "size": number
  /** Storage tier for the volume. Optional. When omitted, the volume is */
  "type"?: VolumeType
}

export type CreatePodRequest = ContainerConfig & {
  "name": string
  /** Cloud tier. Defaults to `SECURE` when omitted. */
  "cloud"?: Cloud
  "cpu"?: CreateCpuConfig
  /** Preferred data centers for placement. Omit or pass an empty */
  "dataCenterIds"?: Array<string>
  /** Enable global networking, giving the pod a private IP reachable across data centers. Requires an NVIDIA GPU and a global-networking-enabled data center (both enforced upstream). See `GET /v2/catalog/datacenters` (`globalNetwork`) for eligible data centers. */
  "globalNetworking"?: boolean
  "gpu"?: CreateGpuConfig
  "mounts"?: Mounts
  /** Create-time flag telling the provisioner to start JupyterLab: */
  "startJupyter"?: boolean
  /** Create-time flag telling the provisioner to set up SSH */
  "startSsh"?: boolean
  /** ID of a pod template to base this pod on. The template is */
  "templateId"?: string
}

export type CreateTemplateRequest = ContainerConfig & {
  "name": string
  /** Acceptable CUDA versions for containers created from this */
  "allowedCudaVersions"?: Array<string>
  /** Optional. Defaults to `NVIDIA` when omitted. */
  "category"?: TemplateCategory
  "mounts"?: TemplateMounts
  "public"?: boolean
  "serverless"?: boolean
  /** Start JupyterLab in containers created from this template: */
  "startJupyter"?: boolean
  /** Provision SSH access in containers created from this template: */
  "startSsh"?: boolean
}

export type CudaVersionAvailability = {
  /** CUDA version as `major.minor`, suitable for `gpu.allowedCudaVersions` on pod create. */
  "version": string
  /** True when at least one machine on this CUDA version has free capacity now. False means the version is offered for this GPU type but is currently full, so a pod constrained to it will fail on capacity. */
  "available": boolean
}

export type DataCenter = {
  "id": string
  "name": string
  "region": DataCenterRegion
  /** Whether this data center supports global networking (private cross-datacenter pod-to-pod network). */
  "globalNetwork": boolean
  /** Network volume tiers this DC supports. Empty = none. */
  "networkVolumeTypes": Array<VolumeType>
  /** Compliance certifications held by this data center */
  "compliance": Array<Compliance>
  /** Availability of each GPU this data center offers. Present only when */
  "gpuAvailability"?: Array<CatalogResourceAvailability>
  /** Availability of each CPU flavor this data center offers. Present */
  "cpuAvailability"?: Array<CatalogResourceAvailability>
}

export type DataCenterAvailability = {
  /** Data center identifier. */
  "id": string
  /** Human-readable data center name. */
  "name": string
  "availability": AvailabilityLevel
}

/** Continental region containing the data center. */
export type DataCenterRegion = "NORTH_AMERICA" | "SOUTH_AMERICA" | "EUROPE" | "ASIA" | "MIDDLE_EAST" | "AFRICA" | "OCEANIA" | "ANTARCTICA" | "UNKNOWN"

export type GpuConfig = {
  /** GPU type identifier */
  "id": string
  /** Number of GPUs */
  "count"?: number
}

/** Canonical GPU hardware manufacturer. */
export type GpuManufacturer = "NVIDIA" | "AMD" | "UNKNOWN"

export type GpuType = {
  /** Individual GPU type identifier (use for pod creation) */
  "id": string
  "name": string
  /** Serverless GPU pool ID (use for serverless endpoint creation). Null if GPU is not in a serverless pool. */
  "pool": string | null
  "manufacturer": GpuManufacturer
  /** VRAM in GB */
  "memory": number
  /** Available on secure cloud */
  "secure": boolean
  /** Available on community cloud */
  "community": boolean
  /** List price in USD per hour for a **single** GPU of this type. Pod */
  "price": {
    "secure": number
    "community": number
    /** Serverless list price per GPU per hour, from the `pool` this GPU */
    "serverless"?: number
  }
  /** The largest number of GPUs you can request on a single pod of this */
  "maxCount": {
    "secure": number
    "community": number
  }
  /** Overall GPU availability for the requested `product` contexts. Present only when requested with include=AVAILABILITY, which also requires `product`. */
  "availability"?: AvailabilityLevel
  /** Per-datacenter GPU availability for the requested `product` */
  "dataCenters"?: Array<DataCenterAvailability>
  /** CUDA versions offered by machines with this GPU type, each tagged */
  "cudaVersions"?: Array<CudaVersionAvailability>
}

/** Storage mounts attached to a pod. At-most-one of `persistent` or */
export type Mounts = {
  "persistent"?: PersistentMount
  "network"?: Array<NetworkMount>
}

/** Reference to a NetworkVolume. Custom paths are honored at runtime on */
export type NetworkMount = {
  /** ID of an existing NetworkVolume in the same data center as the pod. */
  "volumeId": string
  /** Mount path inside the container. No default — must be specified explicitly. */
  "path": string
}

export type NetworkVolume = {
  /** Unique network volume identifier */
  "id": string
  /** Human-readable name (not required to be unique) */
  "name": string
  /** Allocated storage in GB */
  "size": number
  /** Data center location; immutable after creation */
  "dataCenter": string
  /** Storage tier of this volume. Set at creation and immutable. */
  "type": VolumeType
}

/** Host-local persistent storage. Pinned to the pod's host machine — data */
export type PersistentMount = {
  /** Host-local persistent storage in GB. Upstream enforces a 10 GB floor. */
  "size": number
  /** Mount path inside the container. May be changed via PATCH. */
  "path": string
}

export type Pod = ContainerConfig & {
  "id": string
  "name": string
  "status": PodStatus
  /** Valid state transitions for the current status. */
  "actions": Array<PodAction>
  "mounts": Mounts
  /** Present for GPU pods; omitted from CPU pods. */
  "gpu"?: GpuConfig
  /** Present for CPU pods; omitted from GPU pods. */
  "cpu"?: CpuConfig
  "cloud": Cloud
  /** Data center where the pod is running (assigned by scheduler) */
  "dataCenterId": string | null
  /** CUDA version reported by the host machine. Retained while the pod is stopped — a stopped pod keeps its machine assignment and resumes onto the same host. Null means unknown or not applicable (CPU pods, or a host that has not reported one), not that CUDA is absent. */
  "cudaVersion": string | null
  /** SSH connection details, via the Runpod proxy or directly to the pod's published `22/tcp` port. */
  "ssh": PodSsh
  /** Cluster membership; omitted from a standalone pod. Member pods are managed through `/v2/clusters/{id}` — they are excluded from `GET /v2/pods` by default (pass `includeClusterPods=true` to include them) and cannot be modified or deleted via the pod endpoints. */
  "cluster"?: PodCluster
  /** ID of the template this pod was created from */
  "template": string | null
  /** Current cost in USD per hour (0.0 when EXITED or TERMINATED) */
  "cost": number
  /** Whether the pod is locked (prevents stopping or resetting) */
  "locked": boolean
  "globalNetworking": PodGlobalNetworking
  /** Live utilization metrics. Null when the pod is not RUNNING. */
  "runtime": PodRuntime | null
  "createdAt": string
  "startedAt": string | null
}

/** State transition to trigger on a pod. */
export type PodAction = "start" | "stop" | "restart" | "terminate"

/** Pod cost components covering both GPU and CPU pods. Backs a record's amounts and the metadata totals. */
export type PodBillingAmounts = {
  /** Total pod cost in USD for the bucket. */
  "totalAmount": number
  /** GPU pod compute cost in USD for the bucket. */
  "gpuAmount": number
  /** CPU pod compute cost in USD for the bucket. */
  "cpuAmount": number
  /** Pod disk cost in USD for the bucket. */
  "diskAmount": number
}

/** A single time-bucketed pod billing record, covering both GPU and CPU pods. Returned by GET /v2/billing/pods. */
export type PodBillingRecord = BillingTimeRange & PodBillingAmounts & {
  /** The pod this record bills. When the podId filter is set every record carries that id; otherwise one record is emitted per pod per bucket. */
  "podId": string
}

/** A pod's membership in a cluster. */
export type PodCluster = {
  /** ID of the cluster this pod belongs to. */
  "id": string
  /** The pod's node rank within the cluster (NODE_RANK), or null until the index is assigned during provisioning. Rank 0 is the cluster's entry node (`Cluster.primary`); for SLURM it is the controller. */
  "rank": number | null
  /** SLURM or RAY role; omitted for TRAINING/APPLICATION clusters, which do not assign roles. */
  "role"?: PodClusterRole
  /** The pod's address on the cluster's private overlay network; omitted until the address is assigned. */
  "ip"?: string
}

/** A cluster member's role. Assigned for SLURM and RAY clusters; omitted for TRAINING/APPLICATION members. */
export type PodClusterRole = "SLURM_CONTROLLER" | "SLURM_COMPUTE" | "RAY_HEAD" | "RAY_WORKER"

export type PodGlobalNetworking = {
  /** Whether global networking is enabled, giving the pod a private IP reachable across data centers. Derived from whether the pod has an assigned global-network address. */
  "enabled": boolean
  /** The pod's assigned global-networking IP. Present only when enabled. */
  "ip"?: string
  /** Internal DNS name (`<podId>.runpod.internal`), reachable from other globally-networked pods in the same account. Present only when enabled. */
  "internalDns"?: string
}

/** Per-GPU utilization metrics. */
export type PodGpuUtilization = {
  "util"?: number
  "memoryUtil"?: number
}

/** Live utilization metrics for a running pod. */
export type PodRuntime = {
  /** Seconds since the container started */
  "uptime"?: number
  "gpus"?: Array<PodGpuUtilization>
  "cpu"?: Utilization
  "memory"?: Utilization
  "ports"?: Array<PodRuntimePort>
}

/** Live port mapping for a running pod. */
export type PodRuntimePort = {
  "private"?: number
  "public"?: number | null
  "type"?: string
  "ip"?: string | null
}

/** How to connect to this pod over SSH. Both variants authenticate with the account's registered SSH public keys (`PUT /v2/account/ssh-keys`), which reach the pod only if it was created with `startSsh` — a pod created without it has no SSH access regardless of what this block reports. */
export type PodSsh = {
  /** Connection through Runpod's SSH proxy. Works without exposing a port and without a public IP, but carries an interactive shell only — SCP, SFTP, rsync, and port forwarding need `direct`. Null until the pod has a machine assignment. */
  "proxy": PodSshEndpoint | null
  /** Connection straight to the pod's sshd over its published `22/tcp` mapping. Supports the full SSH feature set. Null unless `22/tcp` is in `ports` and the running pod has been assigned a public port for it — so it is absent while the pod is provisioning or stopped. */
  "direct": PodSshEndpoint | null
}

/** One way to reach the pod over SSH, as both its parts and a ready-to-run invocation. */
export type PodSshEndpoint = {
  /** Hostname or IP to connect to. */
  "host": string
  /** TCP port to connect to. */
  "port": number
  /** SSH username. For the proxy this is an opaque routing token, not a user account on the pod. */
  "username": string
  /** The equivalent `ssh` invocation, ready to run. Add `-i <path>` if the matching private key is not one of your default identities, and `-o StrictHostKeyChecking=no` to skip the host-key prompt on short-lived pods. */
  "command": string
}

/** Lifecycle status of a pod. */
export type PodStatus = "PROVISIONING" | "STARTING" | "RUNNING" | "EXITED" | "ERROR" | "TERMINATED"

export type Template = ContainerConfig & {
  "id": string
  "name": string
  "mounts": TemplateMounts
  /** Whether this template is for serverless workers (true) or pods (false) */
  "serverless": boolean
  /** Whether this template is visible to other Runpod users */
  "public": boolean
  "category": TemplateCategory
  /** Whether containers created from this template get SSH access provisioned at startup (`PUBLIC_KEY` env injection). */
  "startSsh": boolean
  /** Whether containers created from this template start JupyterLab at startup (`JUPYTER_PASSWORD` env injection). */
  "startJupyter": boolean
  /** Acceptable CUDA versions for containers created from this template, as `major.minor`. Empty means any version. Expanded into GPU pod and serverless endpoint creates; CPU pods ignore it. */
  "allowedCudaVersions": Array<string>
}

/** Controls how the template is grouped and filtered in the Runpod console. */
export type TemplateCategory = "CPU" | "NVIDIA" | "AMD"

/** Storage mounts attached to a template. Templates support only a */
export type TemplateMounts = {
  "persistent"?: PersistentMount
}

export type UpdatePodRequest = ContainerConfig & {
  /** Enable (true) or disable (false) global networking. Takes effect on the next pod start/restart, not live. Requires an NVIDIA GPU and a global-networking-enabled data center (both enforced upstream). See `GET /v2/catalog/datacenters` (`globalNetwork`) for eligible data centers. */
  "globalNetworking"?: boolean
  /** Lock the pod (true) or unlock it (false). Locked pods cannot be stopped or reset. */
  "locked"?: boolean
  "mounts"?: Mounts
  "name"?: string
  /** ID of a pod template whose container settings are applied as */
  "templateId"?: string
}

/** Single-value utilization percentage (0–100). Shared by `cpu` and `memory`. */
export type Utilization = {
  "util"?: number
}

/** Data center network volume storage type. */
export type VolumeType = "STANDARD" | "HIGH_PERFORMANCE"

/** Every operation the spec exposes, as method + path. */
export const OPERATIONS = {
  getSshKeys: { method: 'GET', path: '/v2/account/ssh-keys' },
  updateSshKeys: { method: 'PUT', path: '/v2/account/ssh-keys' },
  listPods: { method: 'GET', path: '/v2/pods' },
  createPod: { method: 'POST', path: '/v2/pods' },
  getPod: { method: 'GET', path: '/v2/pods/{id}' },
  updatePod: { method: 'PATCH', path: '/v2/pods/{id}' },
  deletePod: { method: 'DELETE', path: '/v2/pods/{id}' },
  getPodLogs: { method: 'GET', path: '/v2/pods/{id}/logs' },
  podAction: { method: 'POST', path: '/v2/pods/{id}/action' },
  listClusters: { method: 'GET', path: '/v2/clusters' },
  createCluster: { method: 'POST', path: '/v2/clusters' },
  getCluster: { method: 'GET', path: '/v2/clusters/{id}' },
  updateCluster: { method: 'PATCH', path: '/v2/clusters/{id}' },
  deleteCluster: { method: 'DELETE', path: '/v2/clusters/{id}' },
  listClusterPods: { method: 'GET', path: '/v2/clusters/{id}/pods' },
  listEndpoints: { method: 'GET', path: '/v2/serverless' },
  createEndpoint: { method: 'POST', path: '/v2/serverless' },
  getEndpoint: { method: 'GET', path: '/v2/serverless/{id}' },
  updateEndpoint: { method: 'PATCH', path: '/v2/serverless/{id}' },
  deleteEndpoint: { method: 'DELETE', path: '/v2/serverless/{id}' },
  listEndpointWorkers: { method: 'GET', path: '/v2/serverless/{id}/workers' },
  listEndpointReleases: { method: 'GET', path: '/v2/serverless/{id}/releases' },
  getWorkerLogs: { method: 'GET', path: '/v2/serverless/{id}/workers/{workerId}/logs' },
  listTemplates: { method: 'GET', path: '/v2/templates' },
  createTemplate: { method: 'POST', path: '/v2/templates' },
  getTemplate: { method: 'GET', path: '/v2/templates/{id}' },
  updateTemplate: { method: 'PATCH', path: '/v2/templates/{id}' },
  deleteTemplate: { method: 'DELETE', path: '/v2/templates/{id}' },
  listNetworkVolumes: { method: 'GET', path: '/v2/network-volumes' },
  createNetworkVolume: { method: 'POST', path: '/v2/network-volumes' },
  getNetworkVolume: { method: 'GET', path: '/v2/network-volumes/{id}' },
  updateNetworkVolume: { method: 'PATCH', path: '/v2/network-volumes/{id}' },
  deleteNetworkVolume: { method: 'DELETE', path: '/v2/network-volumes/{id}' },
  listRegistries: { method: 'GET', path: '/v2/registries' },
  createRegistry: { method: 'POST', path: '/v2/registries' },
  getRegistry: { method: 'GET', path: '/v2/registries/{id}' },
  deleteRegistry: { method: 'DELETE', path: '/v2/registries/{id}' },
  listDelegations: { method: 'GET', path: '/v2/registries/delegations' },
  createDelegation: { method: 'POST', path: '/v2/registries/delegations' },
  revokeDelegation: { method: 'DELETE', path: '/v2/registries/delegations/{id}' },
  listGpuTypes: { method: 'GET', path: '/v2/catalog/gpus' },
  getGpuType: { method: 'GET', path: '/v2/catalog/gpus/{id}' },
  listCpuTypes: { method: 'GET', path: '/v2/catalog/cpus' },
  getCpuType: { method: 'GET', path: '/v2/catalog/cpus/{id}' },
  listDataCenters: { method: 'GET', path: '/v2/catalog/datacenters' },
  getDataCenter: { method: 'GET', path: '/v2/catalog/datacenters/{id}' },
  listPublicTemplates: { method: 'GET', path: '/v2/catalog/templates' },
  listBilling: { method: 'GET', path: '/v2/billing' },
  listPodBilling: { method: 'GET', path: '/v2/billing/pods' },
  listServerlessBilling: { method: 'GET', path: '/v2/billing/serverless' },
  listEndpointBilling: { method: 'GET', path: '/v2/billing/endpoints' },
  listNetworkVolumeBilling: { method: 'GET', path: '/v2/billing/network-volumes' },
  listClusterBilling: { method: 'GET', path: '/v2/billing/clusters' },
} as const
