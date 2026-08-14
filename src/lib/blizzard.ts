import axios from 'axios';

// Blizzard WoW Token price endpoints by region
const API_ENDPOINTS: Record<string, string> = {
    US: 'https://us.api.blizzard.com/data/wow/token/index',
    EU: 'https://eu.api.blizzard.com/data/wow/token/index',
    KR: 'https://kr.api.blizzard.com/data/wow/token/index',
    TW: 'https://tw.api.blizzard.com/data/wow/token/index'
};

export const REGIONS = Object.keys(API_ENDPOINTS);

interface AccessTokenResponse {
    access_token: string;
}

interface TokenResponse {
    price: number;
}

// Fetch an OAuth client-credentials access token from Blizzard.
export async function getAccessToken(): Promise<string> {
    try {
        const response = await axios.post<AccessTokenResponse>('https://oauth.battle.net/token', null, {
            params: { grant_type: 'client_credentials' },
            auth: {
                username: process.env.BLIZZARD_CLIENT_ID || '',
                password: process.env.BLIZZARD_CLIENT_SECRET || ''
            },
            timeout: 10000
        });
        return response.data.access_token;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error('Error getting access token:', {
                message: error.message,
                status: error.response?.status,
                data: error.response?.data
            });
        } else {
            console.error('Error getting access token:', error);
        }
        throw new Error('Failed to get access token');
    }
}

// Fetch the current WoW Token price for a region, in gold.
export async function getTokenPriceInGold(region: string, accessToken: string): Promise<number> {
    const url = API_ENDPOINTS[region];
    if (!url) {
        throw new Error(`Invalid region: ${region}`);
    }

    try {
        const response = await axios.get<TokenResponse>(url, {
            params: {
                namespace: `dynamic-${region.toLowerCase()}`,
                locale: 'en_US'
            },
            // Access token goes in the Authorization header only, never the query string (avoids leaking it into logs).
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 15000
        });

        const price = response.data?.price;
        if (typeof price !== 'number') {
            throw new Error(`Invalid response format: ${JSON.stringify(response.data)}`);
        }

        // Convert from copper to gold (1 gold = 10000 copper)
        return price / 10000;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error(`Error getting token price for ${region}:`, {
                message: error.message,
                status: error.response?.status,
                data: error.response?.data
            });
        } else {
            console.error(`Error getting token price for ${region}:`, error);
        }
        throw new Error(`Failed to get token price for ${region}`);
    }
}
