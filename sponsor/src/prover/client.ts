// A small client for the proof server (midnightntwrk/proof-server 9.0.0-rc.6, the one server the
// sponsor uses; copied from MN Bank's relay, acedward/passport-evm-dapp @ 911647b).
//
// Proving itself goes through the proof server's /prove route (the proof proxy is L-SPONSOR's).
// This client covers what the sponsor needs around it: version and readiness for /health, and the
// capacity the server reports.

export interface ProofServerReady {
  status: string;
  jobsProcessing: number;
  jobsPending: number;
  jobCapacity: number;
}

export interface ProofServerProbe {
  reachable: boolean;
  version: string | null;
  jobCapacity: number | null;
  versionMatches: boolean | null;
}

export class ProofServerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly expectedVersion: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5_000,
  ) {}

  private async get(path: string): Promise<Response> {
    const res = await this.fetchImpl(new URL(path, this.baseUrl), { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`proof server ${path} answered ${res.status}`);
    return res;
  }

  async version(): Promise<string> {
    return (await (await this.get('/version')).text()).trim().replace(/^"|"$/g, '');
  }

  async proofVersions(): Promise<string[]> {
    return (await (await this.get('/proof-versions')).json()) as string[];
  }

  async ready(): Promise<ProofServerReady> {
    return (await (await this.get('/ready')).json()) as ProofServerReady;
  }

  async probe(): Promise<ProofServerProbe> {
    try {
      const [version, ready] = await Promise.all([this.version(), this.ready()]);
      return {
        reachable: true,
        version,
        jobCapacity: typeof ready.jobCapacity === 'number' ? ready.jobCapacity : null,
        versionMatches: this.expectedVersion === null ? null : version === this.expectedVersion,
      };
    } catch {
      return { reachable: false, version: null, jobCapacity: null, versionMatches: null };
    }
  }
}
