import axios from 'axios';

// Thin client for the CubeCoders AMP (Application Management Panel) API.
//
// AMP exposes a JSON-over-POST API. Every call is POST {AMP_URL}/API/<Module>/<Method>
// with a JSON body; authenticated calls carry the session in a `SESSIONID` body field.
// Sessions are short-lived, so callers log in fresh (login is cheap) rather than caching.

// A single AMP instance as reported by ADSModule/GetInstances.
export interface AmpInstance {
    InstanceID: string;
    InstanceName: string;
    FriendlyName: string;
    Running: boolean;
    AppState: number;
    Module: string;
    ApplicationEndpoints?: Array<{ DisplayName: string; Endpoint: string }>;
    Metrics?: Record<string, { RawValue: number; MaxValue: number; Units?: string }>;
}

// Human-readable label for AMP's numeric AppState enum. Values follow AMP's
// ApplicationState enum; unknown values fall back to the raw number.
const APP_STATE_LABELS: Record<number, string> = {
    0: 'Stopped',
    5: 'PreStart',
    7: 'Configuring',
    10: 'Starting',
    20: 'Ready',
    30: 'Restarting',
    40: 'Stopping',
    45: 'Preparing for sleep',
    50: 'Sleeping',
    60: 'Waiting',
    70: 'Installing',
    75: 'Updating',
    80: 'Awaiting user input',
    100: 'Failed',
    200: 'Suspended',
    250: 'Maintenance',
    999: 'Indeterminate'
};

export function appStateLabel(state: number): string {
    return APP_STATE_LABELS[state] ?? `Unknown (${state})`;
}

function ampBaseUrl(): string {
    const url = process.env.AMP_URL;
    if (!url) {
        throw new Error('Missing AMP_URL environment variable');
    }
    // Tolerate a trailing slash so `${base}/API/...` never doubles up.
    return url.replace(/\/+$/, '');
}

// Perform a POST call against the AMP API.
async function ampCall<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const response = await axios.post<T>(`${ampBaseUrl()}/API/${endpoint}`, body, {
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
        },
        timeout: 15000
    });
    return response.data;
}

interface LoginResponse {
    success: boolean;
    sessionID?: string;
    resultReason?: string;
}

// Authenticate and return a session ID for subsequent calls.
export async function login(): Promise<string> {
    const username = process.env.AMP_USERNAME;
    const password = process.env.AMP_PASSWORD;
    if (!username || !password) {
        throw new Error('Missing AMP_USERNAME or AMP_PASSWORD environment variable');
    }

    const data = await ampCall<LoginResponse>('Core/Login', {
        username,
        password,
        token: '',
        rememberMe: false
    });

    if (!data.success || !data.sessionID) {
        throw new Error(`AMP login failed${data.resultReason ? `: ${data.resultReason}` : ''}`);
    }
    return data.sessionID;
}

// GetInstances returns a list of ADS targets, each exposing its own AvailableInstances.
// Shapes vary slightly across AMP versions (bare array vs. { result: [...] }), so we
// normalise both here.
interface AdsTarget {
    InstanceID?: string;
    AvailableInstances?: AmpInstance[];
}

function flattenInstances(payload: unknown): AmpInstance[] {
    const targets: AdsTarget[] = Array.isArray(payload)
        ? (payload as AdsTarget[])
        : ((payload as { result?: AdsTarget[] })?.result ?? []);

    // Each ADS target normally nests its managed instances under AvailableInstances, but be
    // tolerant of versions that return instance-shaped objects at the top level as well.
    return targets.flatMap(target => {
        const nested = target.AvailableInstances ?? [];
        return target.InstanceID ? [target as AmpInstance, ...nested] : nested;
    });
}

// Fetch every instance visible to the account across all ADS targets.
export async function getAllInstances(sessionId: string): Promise<AmpInstance[]> {
    const payload = await ampCall<unknown>('ADSModule/GetInstances', { SESSIONID: sessionId });
    return flattenInstances(payload);
}

// Fetch a single instance by its AMP InstanceID, or null if it is not found.
export async function getInstance(sessionId: string, instanceId: string): Promise<AmpInstance | null> {
    const instances = await getAllInstances(sessionId);
    return instances.find(inst => inst.InstanceID === instanceId) ?? null;
}

interface ActionResultResponse {
    Status?: boolean;
    Reason?: string;
}

// Request AMP to start an instance. AMP returns quickly (the boot happens asynchronously),
// so a successful call means "start was accepted", not "server is up".
export async function startInstance(sessionId: string, instanceId: string): Promise<void> {
    const data = await ampCall<ActionResultResponse>('ADSModule/StartInstance', {
        InstanceId: instanceId,
        SESSIONID: sessionId
    });

    // StartInstance returns an ActionResult; a false Status signals a rejected request.
    if (data && data.Status === false) {
        throw new Error(`AMP StartInstance failed${data.Reason ? `: ${data.Reason}` : ''}`);
    }
}

// Convenience: extract the online/max player count from an instance's metrics.
export function getPlayerCount(instance: AmpInstance): { online: number; max: number } | null {
    const metric = instance.Metrics?.['Active Users'];
    if (!metric) {
        return null;
    }
    return { online: metric.RawValue ?? 0, max: metric.MaxValue ?? 0 };
}
