// GET /admin/export?from=YYYY-MM-DD&to=YYYY-MM-DD&format=xlsx|csv|json — the store owner's data
// export (sales, products, stock, moves, payable, expenses, customers) for analysis elsewhere.
// Owner only: it carries costs, profit and every customer's phone number.

import { Controller, Get, Headers, HttpException, HttpStatus, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { DataExportService, ExportError } from "./data-export.service.js";
import { csvZip, toJson, toXlsx } from "./table-files.js";

const FORMATS = {
  xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  csv: { type: "application/zip", ext: "zip" },
  json: { type: "application/json; charset=utf-8", ext: "json" },
} as const;

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class DataExportController {
  private readonly svc = new DataExportService();

  @Get("export")
  async export(
    @Req() req: Request & { user?: AuthPrincipal },
    @Res() res: Response,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("format") format?: string,
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.MANAGE);
    const f = FORMATS[(format ?? "xlsx") as keyof typeof FORMATS];
    if (!f) throw new HttpException({ type: "validation", message: "Format must be xlsx, csv or json" }, HttpStatus.UNPROCESSABLE_ENTITY);

    let built;
    try {
      built = await this.svc.build(storeId, from, to);
    } catch (e) {
      if (e instanceof ExportError) throw new HttpException({ type: "validation", message: e.message }, HttpStatus.UNPROCESSABLE_ENTITY);
      throw e;
    }
    const body = format === "csv" ? csvZip(built.tables)
      : format === "json" ? JSON.stringify({ store: built.storeName, from: built.fromDay, to: built.toDay, sheets: toJson(built.tables) })
      : toXlsx(built.tables);
    const slug = built.storeName.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "store";
    res.setHeader("Content-Type", f.type);
    res.setHeader("Content-Disposition", `attachment; filename="${slug}-data-${built.fromDay}-to-${built.toDay}.${f.ext}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(body);
  }
}
