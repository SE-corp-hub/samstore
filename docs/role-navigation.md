# Role Navigation Matrix

| Role | Landing | Primary tabs | Hidden by design |
|---|---|---|---|
| PLATFORM_ADMIN | Overview | Overview, Stores, User Access, Maintenance, Analytics, Reports, Settings | POS, product/catalog operations, customer CRM, ERP posting, delivery operations |
| OWNER / STORE_OWNER | Overview | Full store operations, CRM, ERP/BIR, Settings, Store Link, Warehouses | Platform Stores/User Access/Maintenance |
| MANAGER | Overview | POS, orders, products, inventory, purchases, expenses, CRM, ERP/BIR, reports, settings | Platform Stores/User Access/Maintenance, Store Link |
| STAFF | Overview | POS, pre-orders, orders, products, inventory, customers | Finance, ERP/BIR, CRM campaigns, settings, team administration |
| SALES_AGENT | Overview | Orders, customers, CRM, reports | Inventory, payments/refunds, settings, platform administration |
| DELIVERY | Delivery queue | `/admin/delivery` only | Admin dashboard navigation |
| CUSTOMER / guest | Storefront | Catalog, cart, checkout, order tracking | All admin routes |

The frontend hides tabs for usability; API tenant/role guards remain authoritative.
