import axios from 'axios';
import https from 'node:https';

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

// AMP is commonly served over HTTPS with a self-signed certificate, which Node rejects by
// default. Setting AMP_INSECURE_TLS=true opts out of certificate verification for AMP calls
// ONLY (this agent is never applied to Discord/Blizzard/Supabase requests).
const insecureTls = ['true', '1', 'yes'].includes((process.env.AMP_INSECURE_TLS || '').toLowerCase());
const httpsAgent = insecureTls ? new https.Agent({ rejectUnauthorized: false }) : undefined;

// Trim a value to a string safe/small enough to log.
function snippet(value: unknown, max = 1000): string {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (str === undefined) return 'undefined';
    return str.length > max ? `${str.slice(0, max)}…(truncated)` : str;
}

// Perform a POST call against the AMP API. Logs the endpoint on the way in and full HTTP
// error detail (status + response body) on failure, then rethrows an informative Error.
//
// The session is sent in the `Authorization: Bearer` header. AMP deprecated passing it as a
// `SESSIONID` body field, and — critically — a body SESSIONID does NOT authenticate proxied
// instance calls (they fail with "requires the Session.Exists permission"), whereas the Bearer
// header is carried through the controller's proxy to the target instance.
async function ampCall<T>(endpoint: string, body: Record<string, unknown>, sessionId?: string): Promise<T> {
    const url = `${ampBaseUrl()}/API/${endpoint}`;
    console.info(`AMP call -> ${url} (insecureTls=${insecureTls})`);
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json'
    };
    if (sessionId) {
        headers['Authorization'] = `Bearer ${sessionId}`;
    }
    try {
        const response = await axios.post<T>(url, body, {
            headers,
            timeout: 15000,
            httpsAgent
        });
        console.info(`AMP call <- ${endpoint} HTTP ${response.status}`);
        return response.data;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error(`AMP call failed: ${endpoint}`, {
                url,
                code: error.code,
                status: error.response?.status,
                statusText: error.response?.statusText,
                responseData: error.response?.data !== undefined ? snippet(error.response.data) : undefined,
                message: error.message
            });
            const reason = error.response
                ? `HTTP ${error.response.status} ${error.response.statusText ?? ''}`.trim()
                : (error.code || error.message);
            throw new Error(`AMP ${endpoint} request failed: ${reason}`);
        }
        console.error(`AMP call failed (non-axios): ${endpoint}`, error);
        throw error;
    }
}

interface LoginResponse {
    success: boolean;
    result?: number;
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

    // Log the outcome WITHOUT the session token or credentials.
    console.info('AMP login result', {
        success: data.success,
        result: data.result,
        hasSession: !!data.sessionID,
        resultReason: data.resultReason
    });

    if (!data.success || !data.sessionID) {
        throw new Error(
            `AMP login failed: ${data.resultReason || 'success=false or missing sessionID'} ` +
            `(check AMP_USERNAME/AMP_PASSWORD, or two-factor requirement)`
        );
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
    const payload = await ampCall<unknown>('ADSModule/GetInstances', {}, sessionId);
    const instances = flattenInstances(payload);

    if (instances.length === 0) {
        // Nothing matched our flattening — log the raw shape so we can adapt to this AMP version.
        console.warn('AMP GetInstances returned 0 instances after flattening', {
            payloadType: Array.isArray(payload) ? 'array' : typeof payload,
            raw: snippet(payload, 1500)
        });
    } else {
        // Log every instance so a configured InstanceID can be verified against what AMP reports,
        // and so the metric keys (for player count) are visible.
        console.info(`AMP GetInstances returned ${instances.length} instance(s)`, {
            instances: instances.map(i => ({
                InstanceID: i.InstanceID,
                FriendlyName: i.FriendlyName,
                Module: i.Module,
                Running: i.Running,
                AppState: i.AppState,
                metricKeys: Object.keys(i.Metrics ?? {})
            }))
        });
        // Dump the full raw payload so any additional fields (e.g. a game/app name for a
        // GenericModule instance) are visible while we decide what to surface.
        console.info('AMP GetInstances raw payload', { raw: snippet(payload, 4000) });
    }

    return instances;
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
    console.info(`AMP StartInstance requested for ${instanceId}`);
    // AMP's ADSModule.StartInstance parameter is `InstanceName` and it accepts the InstanceID GUID
    // as the value. We send both InstanceName and InstanceId to stay robust across AMP versions;
    // AMP ignores unrecognised keys (an unknown key returns 200 but starts nothing).
    const data = await ampCall<ActionResultResponse>('ADSModule/StartInstance', {
        InstanceName: instanceId,
        InstanceId: instanceId
    }, sessionId);
    console.info('AMP StartInstance result', {
        instanceId,
        status: data?.Status,
        reason: data?.Reason,
        raw: snippet(data)
    });

    // StartInstance returns an ActionResult; a false Status signals a rejected request.
    if (data && data.Status === false) {
        throw new Error(`AMP StartInstance failed${data.Reason ? `: ${data.Reason}` : ''}`);
    }
}

// Log into a specific instance THROUGH the controller's proxy, returning an instance-scoped
// session. A controller session is not valid for an instance's own API — proxied calls fail with
// "requires the Session.Exists permission" — so app-level control needs a session issued by the
// instance itself. The controller session authorises the proxy hop; the body credentials
// authenticate against the instance.
async function instanceLogin(controllerSession: string, instanceId: string): Promise<string> {
    const username = process.env.AMP_USERNAME;
    const password = process.env.AMP_PASSWORD;
    if (!username || !password) {
        throw new Error('Missing AMP_USERNAME or AMP_PASSWORD environment variable');
    }

    const data = await ampCall<LoginResponse>(
        `ADSModule/Servers/${instanceId}/API/Core/Login`,
        { username, password, token: '', rememberMe: false },
        controllerSession
    );
    console.info('AMP instance login result', {
        instanceId,
        success: data.success,
        hasSession: !!data.sessionID,
        resultReason: data.resultReason
    });

    if (!data.success || !data.sessionID) {
        throw new Error(`AMP instance login failed: ${data.resultReason || 'success=false or missing sessionID'}`);
    }
    return data.sessionID;
}

// Start the game APPLICATION inside an instance — distinct from the instance's AMP daemon.
// An instance's daemon can be Running:true while its application AppState is 0 (Stopped) — the
// "paused when empty" state. Starting the app calls the instance's own Core/Start, which requires
// an instance session (obtained via instanceLogin), not the controller session.
export async function startApplication(controllerSession: string, instanceId: string): Promise<void> {
    console.info(`AMP Core/Start (application) requested for ${instanceId}`);
    const instanceSession = await instanceLogin(controllerSession, instanceId);

    const data = await ampCall<ActionResultResponse>(
        `ADSModule/Servers/${instanceId}/API/Core/Start`,
        {},
        instanceSession
    );
    console.info('AMP Core/Start result', {
        instanceId,
        status: data?.Status,
        reason: data?.Reason,
        raw: snippet(data)
    });

    // Core/Start may return void or an ActionResult; only an explicit false Status is a failure.
    if (data && data.Status === false) {
        throw new Error(`AMP Core/Start failed${data.Reason ? `: ${data.Reason}` : ''}`);
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
