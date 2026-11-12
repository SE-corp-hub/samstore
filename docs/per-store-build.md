# Per-store build: one shared stock, own prices, profit, expenses, cash and logins per store

Builder notes for the ten-step build the owner approved on 2026-11-12. One business (`Store`), four
places (`Warehouse`): Bogs and Lucy (main, owns all stock), Bahay Tindahan and Lipa (sell the main
store's rice and pay its cost for what they sell), Bodega (storage, does not sell).

## Rules that hold for every step

- One pull request per step, merged before the next starts.
- The API stays backward compatible: tablets keep an old copy of the app (`apps/web/public/sw.js`)
  and may replay queued requests (`apps/web/src/lib/offlineQueue.ts`). A missing `locationId` means
  the login's home place, then the main place. Never answer an old request shape with a 400.
- Database: migration `20261114100000_per_store_plan` holds every new field for all ten steps and
  only adds. It is applied to the beta database by hand (`beta-database.bat`, or the "Set up database"
  workflow) BEFORE the first step that adds one of its fields to `prisma/schema.prisma` is merged.
  Until a step uses a field, the field is NOT in `schema.prisma`, so the running app never asks for a
  column that might not be there yet.
- Screens follow the easy-read and tablet-fit rules (`easy-read.css`, `use-fit-height.ts`).

## Steps

| # | Step | Needs fields from the migration |
|---|------|---------------------------------|
| 1 | One rule for every way of selling (1a pre-orders, 1b Facebook / online / agent orders with delivery cash, 1c one profit calculation) | none (the index on `Order` only) |
| 2 | Facebook Pages linked to stores, and each store's ordered list of places it may take rice from | `Warehouse.sourceLocationIds`, `facebookPageUrl` |
| 3 | Expenses per store | `Expense.locationId`, `paidFromDrawer`, `voidedAt`, `voidedById`, `voidReason` |
| 4 | Cash at each store | `CashHandover`, `Payment.forLocationId` |
| 5 | Net profit per store on Compare stores | none |
| 6 | The wall: a store login reads only its own store | none |
| 7 | Store head | `UserStore.isLocationHead`, `Product.floorPriceMinor` |
| 8 | Logins that can be handed over | `UserStore.readyLabel` |
| 9 | Each store's own receipt name, target and prefix | `Warehouse.receiptName`, `receiptHeader`, `receiptFooter`, `receiptContact`, `dailySalesTargetMinor`, `orderPrefix` |
| 10 | Make the ready logins and run a whole day on the tablet | none |

## Model lines to add to `prisma/schema.prisma` when a step needs them

These match the migration exactly (generated with `prisma migrate diff`).

```prisma
model Expense {
  locationId     String? // the place this expense belongs to (empty = the whole business)
  location       Warehouse? @relation(fields: [locationId], references: [id], onDelete: SetNull)
  paidFromDrawer Boolean    @default(false) // cash taken out of that store's drawer
  voidedAt       DateTime? // a wrong expense is cancelled, never deleted
  voidedById     String?
  voidReason     String?
  @@index([storeId, locationId, spentAt])
}

model UserStore {
  isLocationHead Boolean @default(false) // head of the home store
  readyLabel     String? // a ready-made login waiting to be handed over ("Lipa head")
}

model Warehouse {
  sourceLocationIds     String[] @default([]) // where this place may take rice from, in order
  facebookPageUrl       String?
  receiptName           String?
  receiptHeader         String?
  receiptFooter         String?
  receiptContact        String?
  dailySalesTargetMinor Int?
  orderPrefix           String?
  expenses              Expense[]
  cashHandovers         CashHandover[]
  paymentsFor           Payment[] @relation("PaymentForLocation")
}

model Product {
  floorPriceMinor Int? // the lowest price a store head may set (owner only)
}

model Payment {
  forLocationId String? // credit paid at one store for another store's sale: the store the money is for
  forLocation   Warehouse? @relation("PaymentForLocation", fields: [forLocationId], references: [id], onDelete: SetNull)
}

model Order {
  @@index([storeId, sellingLocationId, occurredAt])
}

model CashHandover {
  id           String    @id @default(cuid())
  storeId      String
  store        Store     @relation(fields: [storeId], references: [id], onDelete: Cascade)
  locationId   String
  location     Warehouse @relation(fields: [locationId], references: [id], onDelete: Restrict)
  businessDate String // YYYY-MM-DD (Manila)
  amountMinor  Int
  note         String?
  handedById   String
  receivedById String?
  voidedAt     DateTime?
  voidedById   String?
  voidReason   String?
  createdAt    DateTime  @default(now())

  @@index([storeId, locationId, businessDate])
}
```

## The owner's decisions (2026-11-12)

1. Lipa pays Bogs and Lucy the cost of what it sells, the same deal as Bahay Tindahan.
2. A store head sees its own store's profit only.
3. The Messenger price is that store's counter price, plus the delivery fee if any.
4. Staff add expenses for their own store and cannot delete them.
5. Ready logins: a head and a counter login for Bahay Tindahan and for Lipa, one counter login for Bogs and Lucy, one for Bodega.
6. Bodega has no Page and does not sell.
7. One shared customer and credit list; each store sees only its own sales to them.
8. A head may change its own store's prices, never below a lowest price the owner sets.
9. Stores see other places' sack counts only, no money.
10. Take-rice-from lists: Bogs and Lucy = Bahay Tindahan, then Bodega. Bahay Tindahan = Bodega. Lipa = its own shelf only.
11. When Bahay Tindahan or Lipa sells from the other's shelf, the seller keeps the profit and pays Bogs and Lucy the cost.
12. Credit may be paid at another store; the app notes which store the money is for.
13. Bahay Tindahan is the Hub's "Samrice Bauan" business.
14. A customer's special price is one price at every store, set by the owner.
15. Approvals (credit over the limit, damage, voids, count losses) stay with the owner.
