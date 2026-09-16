import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { InsufficientStockError } from "../domain/movements.js";

/**
 * Module 4 fix — domain errors that can only be decided at the database boundary
 * (guarded conditional writes) must never surface as a 500. This filter turns
 * them into the same ApiError shape the rest of the API uses, so the POS/admin
 * panels show a real message ("insufficient stock") instead of a generic failure.
 */
@Catch(InsufficientStockError)
export class InsufficientStockFilter implements ExceptionFilter {
  catch(error: InsufficientStockError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    res.status(HttpStatus.CONFLICT).json({
      type: "conflict",
      message: "Insufficient stock for one or more items — refresh and try again.",
      productId: error.productId,
      shortfall: error.shortfall,
    });
  }
}
