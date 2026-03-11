/**
 * Secure Credential Manager for Aster MCP
 * Uses environment variables for credential storage (Docker-friendly)
 *
 * Credentials are loaded from:
 * - Environment variables: ASTER_API_KEY, ASTER_API_SECRET
 * - These should be passed via docker-compose env_file for security
 */

export interface StoredCredentials {
  apiKey: string;
  apiSecret: string;
}

export class CredentialManager {
  private cachedCredentials: StoredCredentials | null = null;

  /**
   * Get credentials from environment variables
   */
  async getCredentials(): Promise<StoredCredentials | null> {
    // Return cached if available
    if (this.cachedCredentials) {
      return this.cachedCredentials;
    }

    const apiKey = process.env.ASTER_API_KEY;
    const apiSecret = process.env.ASTER_API_SECRET;

    if (apiKey && apiSecret) {
      this.cachedCredentials = { apiKey, apiSecret };
      return this.cachedCredentials;
    }

    return null;
  }

  /**
   * Check if credentials exist in environment
   */
  async hasCredentials(): Promise<boolean> {
    const creds = await this.getCredentials();
    return creds !== null;
  }

  /**
   * Get info about stored credentials (without revealing secrets)
   */
  async getCredentialInfo(): Promise<{
    stored: boolean;
    keyPrefix?: string;
    source: string;
  }> {
    const creds = await this.getCredentials();
    if (creds) {
      return {
        stored: true,
        keyPrefix: creds.apiKey.substring(0, 8) + '...',
        source: 'environment',
      };
    }
    return { stored: false, source: 'none' };
  }

  /**
   * Clear cached credentials (for testing)
   */
  clearCache(): void {
    this.cachedCredentials = null;
  }
}

// Singleton instance for easy access
export const credentialManager = new CredentialManager();
