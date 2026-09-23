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

## Store Onboarding Flow

1. A Platform Admin opens **Stores → Create a new store**.
2. They enter store name, slug, owner email, and owner Philippine mobile number.
3. If the owner is new, the API creates the account, assigns OWNER membership, sets `mustChangePassword`, and returns a one-time temporary password.
4. The UI displays the email, phone, and temporary password once with a secure handoff warning.
5. The owner signs in using email **or phone** plus the temporary password.
6. First login requires a new password plus a matching confirmation field.
7. After changing the password, the owner reaches the selected store dashboard and can use **Team** to create Manager/Staff/Sales Agent/Delivery accounts with the same one-time-password flow.

The temporary password is never emailed or logged by the application; the Platform Admin owns the secure out-of-band handoff.

The frontend hides tabs for usability; API tenant/role guards remain authoritative.
