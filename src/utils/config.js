import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Search for .env file in multiple possible root/parent paths
const possibleEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../.env')
];

let envLoaded = false;
for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    envLoaded = true;
    break;
  }
}

if (!envLoaded) {
  dotenv.config(); // Fallback to standard process env loading
}

export class Config {
  static validate() {
    const requiredSap = ['SAP_BASE_URL', 'SAP_COMPANY_DB', 'SAP_USERNAME', 'SAP_PASSWORD'];
    const missingSap = requiredSap.filter(key => !process.env[key]);
    
    if (missingSap.length > 0) {
      throw new Error(`Missing mandatory SAP Service Layer environment variables: ${missingSap.join(', ')}`);
    }

    if (!process.env.DB_CONNECTION_STRING && (!process.env.DB_SERVER || (!process.env.DB_NAME && !process.env.SAP_COMPANY_DB))) {
      console.warn('⚠️ Direct SQL configuration missing in .env. System will run in Service Layer-only mode.');
    }
  }

  static get sap() {
    return {
      baseUrl: process.env.SAP_BASE_URL,
      companyDb: process.env.SAP_COMPANY_DB,
      username: process.env.SAP_USERNAME,
      password: process.env.SAP_PASSWORD,
    };
  }

  static get sql() {
    const connectionString = process.env.DB_CONNECTION_STRING;
    
    if (connectionString) {
      return {
        connectionString: connectionString,
        options: {
          trustServerCertificate: true,
          enableArithAbort: true
        },
        pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
      };
    }

    if (!process.env.DB_SERVER) return null;

    const rawServer = process.env.DB_SERVER || '';
    const hasInstance = rawServer.includes('\\');
    const serverHost = hasInstance ? rawServer.split('\\')[0] : rawServer;
    const instanceName = hasInstance ? rawServer.split('\\')[1] : undefined;

    const sqlConfig = {
      server: serverHost,
      database: process.env.DB_NAME || process.env.SAP_COMPANY_DB,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      options: {
        encrypt: process.env.DB_ENCRYPT === 'true',
        trustServerCertificate: true,
        enableArithAbort: true,
      },
      pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
    };

    if (instanceName) sqlConfig.options.instanceName = instanceName;
    if (process.env.DB_PORT && !isNaN(process.env.DB_PORT)) {
      sqlConfig.port = parseInt(process.env.DB_PORT, 10);
    }

    return sqlConfig;
  }
}