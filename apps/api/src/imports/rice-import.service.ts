// Rice Ops M12 — go-live import into one store (products + prices per location,
// customers + current utang, staff + PINs, kargadors).
//
// plan() reads the files and the database and says what would change, without
// writing. apply() runs the same plan and refuses to write anything when any row has
// a problem. Both are safe to run again: unchanged rows are left alone, and an
// opening utang is written once (a customer who already has utang in the system is
// adjusted in the app, never overwritten by a file).

import bcrypt from "bcryptjs";
import { prisma } from "../persistence/prisma-repositories.js";
import {
  parseCustomers, parseKargadors, parseProducts, parseStaff,
  type CustomerRow, type ImportError, type KargadorRow, type ProductRow, type SignoffInput, type StaffRow,
} from "../domain/rice-import.js";
import { TeamService } from "../admin/team.service.js";
import { PeopleService } from "../people/people.service.js";
import { accountBelongsToStore } from "../auth/account-scope.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";

export type ImportFiles = { products?: string; customers?: string; staff?: string; kargadors?: string };

export const OPENING_NOTE = "IMPORT:OPENING";

type Count = { create: number; update: number; same: number };
const zero = (): Count => ({ create: 0, update: 0, same: 0 });

export type ImportPlan = {
  errors: ImportError[];
  products: Count;
  locationPrices: number;
  customers: Count;
  openingUtangMinor: number;
  staff: Count;
  kargadors: Count;
  notes: string[];
};

type Loaded = {
  products: ProductRow[]; customers: CustomerRow[]; staff: StaffRow[]; kargadors: KargadorRow[];
  locByCode: Map<string, { id: string; name: string }>;
};

const soldAsOf = (p: { soldByWeight: boolean; stockBaseUnit: string | null; stockBaseQuantity: number | null }) =>
  p.soldByWeight ? "KILO" : p.stockBaseUnit === "g" && p.stockBaseQuantity ? "SACK" : "PIECE";

/** Manila midnight of a YYYY-MM-DD date. */
const manilaDay = (ymd: string) => new Date(`${ymd}T00:00:00+08:00`);

export class RiceImportService {
  private readonly team = new TeamService();
  private readonly people = new PeopleService();

  private async load(storeId: string, files: ImportFiles, today: string): Promise<{ loaded: Loaded; errors: ImportError[] }> {
    const locs = await prisma.warehouse.findMany({ where: { storeId, isActive: true, code: { not: null } }, select: { id: true, code: true, name: true } });
    const locByCode = new Map(locs.map((l) => [l.code!.toUpperCase(), { id: l.id, name: l.name }]));
    const codes = [...locByCode.keys()];
    const errors: ImportError[] = [];
    const take = <T>(p: { rows: T[]; errors: ImportError[] } | null): T[] => {
      if (!p) return [];
      errors.push(...p.errors);
      return p.rows;
    };
    const loaded: Loaded = {
      products: take(files.products !== undefined ? parseProducts(files.products, codes) : null),
      customers: take(files.customers !== undefined ? parseCustomers(files.customers, today) : null),
      staff: take(files.staff !== undefined ? parseStaff(files.staff, codes) : null),
      kargadors: take(files.kargadors !== undefined ? parseKargadors(files.kargadors, codes) : null),
      locByCode,
    };
    return { loaded, errors };
  }

  /** What the files would change. Never writes. */
  async plan(storeId: string, files: ImportFiles, today: string): Promise<ImportPlan> {
    const { loaded, errors } = await this.load(storeId, files, today);
    const out: ImportPlan = { errors, products: zero(), locationPrices: 0, customers: zero(), openingUtangMinor: 0, staff: zero(), kargadors: zero(), notes: [] };

    // products
    if (loaded.products.length) {
      const existing = await prisma.product.findMany({
        where: { storeId, sku: { in: loaded.products.map((p) => p.sku) } },
        select: { sku: true, name: true, variety: true, priceMinor: true, costMinor: true, soldByWeight: true, stockBaseUnit: true, stockBaseQuantity: true, isActive: true, reviewStatus: true, locationPrices: { select: { warehouseId: true, priceMinor: true } } },
      });
      const bySku = new Map(existing.map((p) => [p.sku, p]));
      const names = await prisma.product.findMany({ where: { storeId, name: { in: loaded.products.map((p) => p.name), mode: "insensitive" } }, select: { sku: true, name: true } });
      for (const row of loaded.products) {
        out.locationPrices += Object.keys(row.locationPrices).length;
        const clash = names.find((n) => n.name.toLowerCase() === row.name.toLowerCase() && n.sku !== row.sku);
        if (clash) errors.push({ file: "products.csv", row: row.row, message: `"${row.name}" already exists with SKU ${clash.sku} — use that SKU` });
        const cur = bySku.get(row.sku);
        if (!cur) { out.products.create += 1; continue; }
        if (cur.reviewStatus === "MERGED") { errors.push({ file: "products.csv", row: row.row, message: `SKU ${row.sku} was merged into another product — use that product's SKU` }); continue; }
        const was = soldAsOf(cur);
        if (was !== row.soldAs || (row.soldAs === "SACK" && cur.stockBaseQuantity !== row.gramsPerSack)) {
          errors.push({ file: "products.csv", row: row.row, message: `SKU ${row.sku} is already sold as ${was}${was === "SACK" ? ` (${(cur.stockBaseQuantity ?? 0) / 1000} kg)` : ""} — that cannot change by import` });
          continue;
        }
        const wantPrices = new Map(Object.entries(row.locationPrices).map(([c, v]) => [loaded.locByCode.get(c)!.id, v]));
        const samePrices = cur.locationPrices.length === wantPrices.size && cur.locationPrices.every((lp) => wantPrices.get(lp.warehouseId) === lp.priceMinor);
        const same = cur.name === row.name && (cur.variety ?? null) === row.variety && cur.priceMinor === row.priceMinor && cur.costMinor === row.costMinor && cur.isActive && cur.reviewStatus === "ACTIVE" && samePrices;
        if (same) out.products.same += 1; else out.products.update += 1;
      }
    }

    // customers
    if (loaded.customers.length) {
      const scs = await prisma.storeCustomer.findMany({
        where: { storeId, customer: { phone: { in: loaded.customers.map((c) => c.phone) } } },
        select: { id: true, creditLimitMinor: true, creditBalanceMinor: true, customer: { select: { phone: true, name: true } }, credit: { select: { amountMinor: true, note: true } } },
      });
      const byPhone = new Map(scs.map((s) => [s.customer.phone!, s]));
      for (const row of loaded.customers) {
        const cur = byPhone.get(row.phone);
        if (!cur) {
          out.customers.create += 1;
          out.openingUtangMinor += row.utangMinor;
          continue;
        }
        const opening = cur.credit.filter((c) => c.note?.startsWith(OPENING_NOTE));
        const openingSum = opening.reduce((a, c) => a + c.amountMinor, 0);
        if (row.utangMinor > 0 || opening.length) {
          if (opening.length && openingSum !== row.utangMinor) {
            errors.push({ file: "customers.csv", row: row.row, message: `${row.name}: opening credit was already imported as ${openingSum / 100} — change it in the app (Credit), not by file` });
            continue;
          }
          if (!opening.length && cur.credit.length) {
            errors.push({ file: "customers.csv", row: row.row, message: `${row.name}: already has credit activity in the system — leave utang blank for this customer` });
            continue;
          }
          if (!opening.length) out.openingUtangMinor += row.utangMinor;
        }
        const same = cur.creditLimitMinor === row.limitMinor && (opening.length > 0 || row.utangMinor === 0);
        if (same) out.customers.same += 1; else out.customers.update += 1;
      }
    }

    // staff
    for (const row of loaded.staff) {
      const user = await prisma.user.findFirst({ where: { phone: row.phone }, select: { id: true, name: true, pinHash: true, memberships: { where: { storeId }, select: { role: true, status: true, homeLocationId: true } } } });
      if (!user) { out.staff.create += 1; continue; }
      const m = user.memberships[0];
      if (m?.role === "OWNER") { errors.push({ file: "staff.csv", row: row.row, message: `${row.phone} is this store's owner — leave the owner out of staff.csv` }); continue; }
      const own = await accountBelongsToStore(prisma, user.id, storeId);
      if (!own && row.pin) out.notes.push(`${row.name}: also works at another store — their PIN is not changed here (they set it themselves)`);
      const home = row.home ? loaded.locByCode.get(row.home)!.id : null;
      const samePin = !row.pin || (user.pinHash ? await bcrypt.compare(row.pin, user.pinHash) : false) || !own;
      const same = !!m && m.status === "ACTIVE" && m.role === row.role && (m.homeLocationId ?? null) === home && samePin;
      if (same) out.staff.same += 1; else out.staff.update += 1;
    }

    // kargadors
    if (loaded.kargadors.length) {
      const ks = await prisma.kargador.findMany({ where: { storeId, name: { in: loaded.kargadors.map((k) => k.name) } }, select: { name: true, phone: true, homeLocationId: true, photoUrl: true, isActive: true } });
      const byName = new Map(ks.map((k) => [k.name, k]));
      for (const row of loaded.kargadors) {
        const cur = byName.get(row.name);
        if (!cur) { out.kargadors.create += 1; continue; }
        const home = row.home ? loaded.locByCode.get(row.home)!.id : null;
        const same = cur.isActive && (cur.phone ?? null) === row.phone && (cur.homeLocationId ?? null) === home && (row.photoUrl === null || cur.photoUrl === row.photoUrl);
        if (same) out.kargadors.same += 1; else out.kargadors.update += 1;
      }
    }
    return out;
  }

  /**
   * Writes the files into the store. Nothing is written when the plan has any error.
   * Returns the plan, plus the one-time logins of newly created staff (shown once —
   * hand them out, then delete the file they were saved to).
   */
  async apply(storeId: string, actorUserId: string, files: ImportFiles, today: string) {
    const plan = await this.plan(storeId, files, today);
    if (plan.errors.length) return { ok: false as const, plan };
    const { loaded } = await this.load(storeId, files, today);
    const logins: { name: string; phone: string; tempPassword: string }[] = [];

    if (loaded.products.length) {
      await prisma.$transaction(async (tx) => {
        for (const row of loaded.products) {
          const shape = row.soldAs === "SACK"
            ? { unit: "sako", soldByWeight: false, stockBaseUnit: "g", stockBaseQuantity: row.gramsPerSack, stockConversionFamily: "Bigas" }
            : row.soldAs === "KILO"
              ? { unit: "kilo", soldByWeight: true, stockBaseUnit: "g", stockBaseQuantity: 1, stockConversionFamily: "Bigas" }
              : { unit: "pc", soldByWeight: false, stockBaseUnit: null, stockBaseQuantity: null, stockConversionFamily: null };
          const fields = { name: row.name, variety: row.variety, priceMinor: row.priceMinor, costMinor: row.costMinor, isActive: true, reviewStatus: "ACTIVE" as const };
          const before = await tx.product.findUnique({ where: { storeId_sku: { storeId, sku: row.sku } }, select: { id: true, priceMinor: true, costMinor: true } });
          const p = before
            ? await tx.product.update({ where: { id: before.id }, data: fields, select: { id: true } })
            : await tx.product.create({ data: { storeId, sku: row.sku, createdById: actorUserId, ...fields, ...shape }, select: { id: true } });
          const keep: string[] = [];
          for (const [code, priceMinor] of Object.entries(row.locationPrices)) {
            const warehouseId = loaded.locByCode.get(code)!.id;
            keep.push(warehouseId);
            await tx.locationPrice.upsert({
              where: { storeId_productId_warehouseId: { storeId, productId: p.id, warehouseId } },
              update: { priceMinor, updatedBy: actorUserId },
              create: { storeId, productId: p.id, warehouseId, priceMinor, updatedBy: actorUserId },
            });
          }
          await tx.locationPrice.deleteMany({ where: { storeId, productId: p.id, warehouseId: { notIn: keep } } }); // blank = main price
          await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actorUserId, action: before ? "import.product_update" : "import.product_create", entityType: "Product", entityId: p.id, before: before ? { priceMinor: before.priceMinor, costMinor: before.costMinor } : undefined, after: { sku: row.sku, priceMinor: row.priceMinor, costMinor: row.costMinor, locationPrices: row.locationPrices } } });
        }
      }, { timeout: 120_000, maxWait: 20_000 });
    }

    if (loaded.customers.length) {
      await prisma.$transaction(async (tx) => {
        for (const row of loaded.customers) {
          const customer = (await tx.customer.findFirst({ where: { phone: row.phone }, select: { id: true } }))
            ?? (await tx.customer.create({ data: { name: row.name, phone: row.phone, email: null, passwordHash: null }, select: { id: true } }));
          const sc = await tx.storeCustomer.upsert({
            where: { storeId_customerId: { storeId, customerId: customer.id } },
            update: { creditLimitMinor: row.limitMinor, creditApproved: row.limitMinor > 0 },
            create: { storeId, customerId: customer.id, creditLimitMinor: row.limitMinor, creditApproved: row.limitMinor > 0 },
            select: { id: true, credit: { select: { id: true }, take: 1 } },
          });
          if (row.utangMinor > 0 && sc.credit.length === 0) {
            const at = manilaDay(row.utangSince!);
            await tx.creditEntry.create({
              data: { storeId, storeCustomerId: sc.id, type: "purchase", amountMinor: row.utangMinor, startAt: at, createdAt: at, note: `${OPENING_NOTE} opening credit before going live${row.note ? ` — ${row.note}` : ""}`, createdBy: actorUserId },
            });
            // Guarded: only a customer with no utang yet gets the opening balance.
            const set = await tx.storeCustomer.updateMany({ where: { id: sc.id, creditBalanceMinor: 0 }, data: { creditBalanceMinor: row.utangMinor } });
            if (set.count !== 1) throw new Error(`${row.name}: credit changed while importing — run the import again`);
          }
          await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actorUserId, action: "import.customer", entityType: "StoreCustomer", entityId: sc.id, after: { name: row.name, limitMinor: row.limitMinor, openingUtangMinor: row.utangMinor } } });
        }
      }, { timeout: 120_000, maxWait: 20_000 });
      await cacheBust(cacheKey("credit-ledger", storeId));
      await cacheBust(cacheKey("customers", storeId));
    }

    for (const row of loaded.staff) {
      const home = row.home ? loaded.locByCode.get(row.home)!.id : null;
      const invited = await this.team.invite(storeId, "", row.name, row.role, row.phone, home);
      if (!invited.ok) throw new Error(`${row.name}: ${invited.error.type === "validation" ? invited.error.errors.join(", ") : invited.error.message}`);
      if (invited.value.tempPassword) logins.push({ name: row.name, phone: row.phone, tempPassword: invited.value.tempPassword });
      if (row.pin && (await accountBelongsToStore(prisma, invited.value.userId, storeId))) {
        const u = await prisma.user.findUnique({ where: { id: invited.value.userId }, select: { pinHash: true } });
        if (!u?.pinHash || !(await bcrypt.compare(row.pin, u.pinHash))) {
          const set = await this.people.updateMember(storeId, invited.value.userId, { pin: row.pin }, actorUserId);
          if (!set.ok) throw new Error(`${row.name}: ${set.error.type === "validation" ? set.error.errors.join(", ") : set.error.message}`);
        }
      }
    }

    for (const row of loaded.kargadors) {
      const home = row.home ? loaded.locByCode.get(row.home)!.id : null;
      await prisma.kargador.upsert({
        where: { storeId_name: { storeId, name: row.name } },
        update: { phone: row.phone, homeLocationId: home, isActive: true, ...(row.photoUrl ? { photoUrl: row.photoUrl } : {}) },
        create: { storeId, name: row.name, phone: row.phone, homeLocationId: home, photoUrl: row.photoUrl },
      });
    }
    return { ok: true as const, plan, logins };
  }

  /** What is in the store now, for the owner's sign-off sheet (read back from the database, not the files). */
  async signoff(storeId: string, generatedAt: string): Promise<SignoffInput> {
    const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { name: true } });
    const locs = await prisma.warehouse.findMany({ where: { storeId, isActive: true, code: { not: null } }, orderBy: [{ type: "asc" }, { code: "asc" }], select: { id: true, code: true, name: true } });
    const codeOf = new Map(locs.map((l) => [l.id, l.code!]));
    const products = await prisma.product.findMany({
      where: { storeId, isActive: true, reviewStatus: "ACTIVE" }, orderBy: [{ name: "asc" }],
      select: { sku: true, name: true, priceMinor: true, costMinor: true, soldByWeight: true, stockBaseUnit: true, stockBaseQuantity: true, locationPrices: { select: { warehouseId: true, priceMinor: true } } },
    });
    const customers = await prisma.storeCustomer.findMany({
      where: { storeId }, orderBy: [{ creditBalanceMinor: "desc" }],
      select: { creditLimitMinor: true, creditBalanceMinor: true, customer: { select: { name: true, phone: true } }, credit: { where: { type: "purchase" }, orderBy: { createdAt: "asc" }, take: 1, select: { createdAt: true } } },
    });
    const ymd = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
    return {
      storeName: store.name,
      generatedAt,
      locations: locs.map((l) => ({ code: l.code!, name: l.name })),
      products: products.map((p) => ({
        sku: p.sku, name: p.name, priceMinor: p.priceMinor, costMinor: p.costMinor,
        soldAs: soldAsOf(p) === "SACK" ? `SACK ${(p.stockBaseQuantity ?? 0) / 1000} kg` : soldAsOf(p),
        locationPrices: Object.fromEntries(p.locationPrices.filter((lp) => codeOf.has(lp.warehouseId)).map((lp) => [codeOf.get(lp.warehouseId)!, lp.priceMinor])),
      })),
      customers: customers.map((c) => ({
        name: c.customer.name ?? "", phone: c.customer.phone ?? "", limitMinor: c.creditLimitMinor, utangMinor: c.creditBalanceMinor,
        utangSince: c.creditBalanceMinor > 0 && c.credit[0] ? ymd(c.credit[0].createdAt) : null,
      })),
      staffCount: await prisma.userStore.count({ where: { storeId, status: "ACTIVE", role: { not: "OWNER" } } }),
      kargadorCount: await prisma.kargador.count({ where: { storeId, isActive: true } }),
    };
  }
}
