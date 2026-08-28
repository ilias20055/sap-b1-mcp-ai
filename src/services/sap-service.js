import axios from 'axios';
import https from 'https';
import { Config } from '../utils/config.js';

export class SAPService {
  constructor() {
    Config.validate();
    this.config = Config.sap;
    this.sessionCookie = null;
    this.axios = axios.create({
      baseURL: this.config.baseUrl.endsWith('/') ? this.config.baseUrl : `${this.config.baseUrl}/`,
      timeout: 30000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async login() {
    try {
      const res = await this.axios.post('Login', {
        CompanyDB: this.config.companyDb,
        UserName: this.config.username,
        Password: this.config.password
      });
      const setCookie = res.headers['set-cookie'];
      if (setCookie) {
        this.sessionCookie = setCookie.map(c => c.split(';')[0]).join('; ');
      }
      return true;
    } catch (err) {
      throw new Error(`SAP B1 Authentication Failed: ${err.response?.data?.error?.message?.value || err.message}`);
    }
  }

  async request(method, endpoint, data = null, params = {}, isRetry = false) {
    if (!this.sessionCookie) await this.login();
    try {
      const res = await this.axios({
        method,
        url: endpoint,
        data,
        params,
        headers: { Cookie: this.sessionCookie }
      });
      return res.data;
    } catch (err) {
      // Automatic re-login on session expiration (401) with max 1 retry
      if (err.response?.status === 401 && !isRetry) {
        await this.login();
        return await this.request(method, endpoint, data, params, true);
      }
      throw err;
    }
  }

  async healthCheck() {
    try {
      await this.login();
      return { status: 'connected', message: 'Successfully connected to SAP B1 Service Layer' };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  }

  async getProducts(top = 10, skip = 0, search = '') {
    const params = { '$top': top, '$skip': skip, '$select': 'ItemCode,ItemName,QuantityOnStock' };
    if (search) params['$filter'] = `contains(ItemName, '${search}') or contains(ItemCode, '${search}')`;
    return await this.request('GET', 'Items', null, params);
  }

  async getEmployees(top = 10, skip = 0) {
    const params = { '$top': top, '$skip': skip, '$select': 'EmployeeID,FirstName,LastName,JobTitle,Department' };
    return await this.request('GET', 'EmployeesInfo', null, params);
  }

  async getBusinessPartners(type = 'C', top = 10, skip = 0, search = '') {
    const cardType = type === 'S' ? 'cSupplier' : 'cCustomer';
    const params = { 
      '$top': top, 
      '$skip': skip, 
      '$select': 'CardCode,CardName,CardType,Phone1,CurrentAccountBalance',
      '$filter': `CardType eq '${cardType}'`
    };
    if (search) {
      params['$filter'] += ` and (contains(CardName, '${search}') or contains(CardCode, '${search}'))`;
    }
    return await this.request('GET', 'BusinessPartners', null, params);
  }

  async createSalesOrder(cardCode, docDueDate, items) {
    const payload = {
      CardCode: cardCode,
      DocDueDate: docDueDate || new Date().toISOString().split('T')[0],
      DocumentLines: items.map(item => ({
        ItemCode: item.itemCode,
        Quantity: item.quantity,
        UnitPrice: item.price
      }))
    };
    return await this.request('POST', 'Orders', payload);
  }

  /**
   * MAP SQL/SAP Table Names to Service Layer OData Entities
   */
  mapTableToEntity(tableName) {
    const tableMap = {
      'OITM': 'Items',
      'OCRD': 'BusinessPartners',
      'OINV': 'Invoices',
      'ORDR': 'Orders',
      'OWHS': 'Warehouses',
      'OCPR': 'ContactEmployees',
      'OQUT': 'Quotations',
      'ODLN': 'DeliveryNotes',
      'OHEM': 'EmployeesInfo',        // Employees table
      'OPOR': 'PurchaseOrders',      // Purchase Orders
      'OPCH': 'PurchaseInvoices',    // AP Invoices
      'ORCT': 'IncomingPayments',    // Payments Received
      'OVPM': 'VendorPayments',      // Payments Out
      'OWOR': 'ProductionOrders',    // Production Orders Header
      'WOR1': 'ProductionOrders'     // Production Orders Lines
    };

    const cleanTable = tableName.trim().toUpperCase();

    // Standard SAP Table mapping
    if (tableMap[cleanTable]) {
      return tableMap[cleanTable];
    }

    // UDT (User Defined Tables) Mapping: e.g. @MYTABLE -> U_MYTABLE
    if (cleanTable.startsWith('@')) {
      return `U_${cleanTable.substring(1)}`;
    }

    return tableName;
  }

  /**
   * Service Layer Fallback Table Data Fetcher
   */
  async getTableData(tableName, top = 5, skip = 0, filter = null) {
    const entityName = this.mapTableToEntity(tableName);
    const params = { 
      '$top': top, 
      '$skip': skip 
    };
    
    if (filter) {
      params['$filter'] = filter;
    }

    try {
      return await this.request('GET', entityName, null, params);
    } catch (err) {
      throw new Error(`Failed to fetch Service Layer entity [${entityName}]: ${err.response?.data?.error?.message?.value || err.message}`);
    }
  }
}