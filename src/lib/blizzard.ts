import axios from 'axios';
import { errorToLogMetadata, consoleLog, LogLike } from './logger';

export type Region = 'US' | 'EU' | 'KR' | 'TW';

interface RegionConfig {
    url: string;
    namespace: string;
}

const REGIONS: Record<Region, RegionConfig> = {
    US: { url: 'https://us.api.blizzard.com', namespace: 'dynamic-us' },
    EU: { url: 'https://eu.api.blizzard.com', namespace: 'dynamic-eu' },
    KR: { url: 'https://kr.api.blizzard.com', namespace: 'dynamic-kr' },
    TW: { url: 'https://tw.api.blizzard.com', namespace: 'dynamic-tw' }
};

function isRegion(region: string): region is Region {
    return Object.prototype.hasOwnProperty.call(REGIONS, region);
}

interface AccessTokenResponse {
    access_token: string;
}

// Get an OAuth2 client-credentials access token for the Blizzard Battle.net API
export async function getAccessToken(logger: LogLike = consoleLog): Promise<string> {
    try {
        logger.info('Getting access token...');
        const response = await axios.post<AccessTokenResponse>('https://oauth.battle.net/token', null, {
            params: {
                grant_type: 'client_credentials'
            },
            auth: {
                username: process.env.BLIZZARD_CLIENT_ID || '',
                password: process.env.BLIZZARD_CLIENT_SECRET || ''
            },
            timeout: 10000
        });
        logger.info('Access token received successfully');
        return response.data.access_token;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            logger.error('Error getting access token', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status,
                headers: error.response?.headers
            });
        } else {
            logger.error('Error getting access token', errorToLogMetadata(error));
        }
        throw new Error('Failed to get access token');
    }
}

interface TokenIndexResponse {
    price: number;
}

// Get the current WoW Token price for a region, in gold (converted from copper)
export async function getTokenPrice(region: string, accessToken: string, logger: LogLike = consoleLog): Promise<number> {
    if (!isRegion(region)) {
        throw new Error(`Invalid region: ${region}`);
    }
    const { url, namespace } = REGIONS[region];

    try {
        logger.info(`Getting token price for ${region}...`);
        const params = {
            namespace,
            locale: 'en_US',
            access_token: accessToken
        };

        const response = await axios.get<TokenIndexResponse>(`${url}/data/wow/token/index`, {
            params,
            headers: {
                'Authorization': `Bearer ${accessToken}`
            },
            timeout: 10000
        });

        if (!response.data || !response.data.price) {
            throw new Error(`Invalid response format: ${JSON.stringify(response.data)}`);
        }

        // Convert from copper to gold (1 gold = 10000 copper)
        return response.data.price / 10000;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            logger.error(`Error getting token price for ${region}`, {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status,
                headers: error.response?.headers
            });
        } else {
            logger.error(`Error getting token price for ${region}`, errorToLogMetadata(error));
        }
        throw new Error(`Failed to get token price for ${region}`);
    }
}

// Check whether a realm's connected realm group is currently UP
export async function checkRealmStatus(realmName: string, region: string, accessToken: string, logger: LogLike = consoleLog): Promise<boolean> {
    try {
        const regionLower = region.toLowerCase();
        const baseUrl = `https://${regionLower}.api.blizzard.com`;

        // Convert realm name to slug (lowercase, spaces to hyphens)
        const realmSlug = realmName.toLowerCase().replace(/\s+/g, '-').replace(/'/g, '');

        logger.info(`Checking realm status for ${realmName} (slug: ${realmSlug})`);

        // Get the realm directly by slug
        const realmResponse = await axios.get(`${baseUrl}/data/wow/realm/${realmSlug}`, {
            params: {
                namespace: `dynamic-${regionLower}`,
                locale: 'en_US'
            },
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 15000
        });

        // Extract connected realm ID from the href
        const connectedRealmHref = realmResponse.data.connected_realm?.href;
        if (!connectedRealmHref) {
            logger.warn(`No connected realm found for ${realmName}`);
            return false;
        }

        // Get connected realm status
        const connectedRealmResponse = await axios.get(connectedRealmHref, {
            params: {
                namespace: `dynamic-${regionLower}`,
                locale: 'en_US'
            },
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 15000
        });

        const status = connectedRealmResponse.data.status?.type;
        logger.info(`Realm ${realmName} (${region}) status: ${status}`);

        return status === 'UP';
    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
            logger.warn(`Realm "${realmName}" not found in ${region}`);
        } else {
            logger.warn(`Realm ${realmName} check failed`, errorToLogMetadata(error));
        }
        return false;
    }
}
