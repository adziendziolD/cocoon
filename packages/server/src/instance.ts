/**
 * Several CoCoon servers can share one Docker/Podman host (e.g. integration tests next to a live instance):
 * COCOON_INSTANCE gives the Docker resources of one server (network, proxy, services, toolbox) their own names.
 */
export const INSTANCE = (process.env.COCOON_INSTANCE ?? '').replace(/[^a-z0-9-]/gi, '').toLowerCase();

/** Docker resource name for this instance ("cocoon-internal" → "cocoon-internal-test"). */
export const scoped = (name: string) => (INSTANCE ? `${name}-${INSTANCE}` : name);
