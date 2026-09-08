import type { Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { InternalRequisitionModel } from "../models/internal-requisition.model";
import { RawMaterialModel } from "../models/raw-material.model";
import { WarehouseMovementModel } from "../models/warehouse-movement.model";
import { AuthRequest } from "../types/AuthRequest";
import { syncMovementToContifico } from "../services/contifico-sync.service";

// --- Crear requerimiento (cocina/producción/isla pide a bodega) ---
export async function createRequisition(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { area, brand, neededForDate, items, notes, requestedByName } = req.body;
    const userId = (req.user as any)?.id || (req.user as any)?._id || req.body.requestedBy;

    if (!userId) {
      return res.status(401).send({ message: "User authentication required." });
    }
    if (!area || !Array.isArray(items) || !items.length) {
      return res.status(400).send({ message: "area and items[] are required." });
    }

    const requisition = new InternalRequisitionModel({
      requestedBy: userId,
      requestedByName: requestedByName || (req.user as any)?.name || "—",
      area,
      brand,
      neededForDate: neededForDate ? new Date(neededForDate) : undefined,
      items,
      notes,
      status: "REQUESTED",
    });

    await requisition.save();
    return res.status(201).send({ message: "Requerimiento creado.", requisition });
  } catch (error) {
    console.error("Error creating requisition:", error);
    next(error);
  }
}

// --- Listar (filtros: status, area, brand, fechas) ---
export async function getRequisitions(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const query: any = {};
    if (req.query.status) {
      query.status = Array.isArray(req.query.status)
        ? { $in: req.query.status }
        : req.query.status;
    }
    if (req.query.area) query.area = req.query.area;
    if (req.query.brand) query.brand = req.query.brand;
    if (req.query.startDate || req.query.endDate) {
      query.createdAt = {};
      if (req.query.startDate) query.createdAt.$gte = new Date(req.query.startDate as string);
      if (req.query.endDate) query.createdAt.$lte = new Date(req.query.endDate as string);
    }

    const requisitions = await InternalRequisitionModel.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(req.query.limit as string) || 200)
      .populate("items.material", "name unit quantity");

    return res.status(200).send({ count: requisitions.length, requisitions });
  } catch (error) {
    console.error("Error fetching requisitions:", error);
    next(error);
  }
}

// --- Contador de pendientes (alerta para bodega) ---
export async function getPendingCount(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const count = await InternalRequisitionModel.countDocuments({
      status: { $in: ["REQUESTED", "PREPARING"] },
    });
    return res.status(200).send({ count });
  } catch (error) {
    next(error);
  }
}

// --- Cambiar estado simple (PREPARING / CANCELLED) ---
export async function updateStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["PREPARING", "CANCELLED"].includes(status)) {
      return res.status(400).send({ message: "status must be PREPARING or CANCELLED." });
    }

    const requisition = await InternalRequisitionModel.findById(id);
    if (!requisition) return res.status(404).send({ message: "Requisition not found." });
    if (["DISPATCHED", "CONFIRMED"].includes(requisition.status)) {
      return res.status(400).send({ message: "No se puede modificar un requerimiento ya despachado." });
    }

    requisition.status = status;
    await requisition.save();
    return res.status(200).send({ message: "Estado actualizado.", requisition });
  } catch (error) {
    next(error);
  }
}

// --- Despachar: genera movimientos OUT y descuenta stock ---
export async function dispatchRequisition(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const { dispatchedBy, items: dispatchItems } = req.body;
    const userId = (req.user as any)?.id || (req.user as any)?._id;

    if (!userId) {
      return res.status(401).send({ message: "User authentication required." });
    }

    const requisition = await InternalRequisitionModel.findById(id);
    if (!requisition) return res.status(404).send({ message: "Requisition not found." });
    if (["DISPATCHED", "CONFIRMED", "CANCELLED"].includes(requisition.status)) {
      return res.status(400).send({ message: `El requerimiento ya está en estado ${requisition.status}.` });
    }

    const batchId = randomUUID();
    const movements: any[] = [];

    for (const item of requisition.items) {
      const override = Array.isArray(dispatchItems)
        ? dispatchItems.find((d: any) => d.itemId === (item as any)._id?.toString())
        : undefined;
      const qty = override?.quantityDispatched !== undefined
        ? Number(override.quantityDispatched)
        : item.quantity;

      item.quantityDispatched = qty;
      if (override?.itemNote) item.itemNote = override.itemNote;
      if (qty <= 0) continue;

      // Ítems sin materia prima vinculada (vienen del cierre POS con un nombre que no
      // calza en el catálogo): se despachan pero no descuentan stock.
      if (!item.material) {
        item.itemNote = item.itemNote || "Sin materia prima vinculada: no descuenta stock";
        continue;
      }
      const material = await RawMaterialModel.findById(item.material);
      if (!material) {
        return res.status(404).send({ message: `Materia prima no encontrada: ${item.name}` });
      }
      if (material.quantity < qty) {
        return res.status(400).send({
          message: `Stock insuficiente de "${material.name}". Disponible: ${material.quantity} ${material.unit}`,
        });
      }

      material.quantity -= qty;
      material.lastMovementDate = new Date();
      await material.save();

      movements.push({
        type: "OUT",
        rawMaterial: material._id,
        quantity: qty,
        unitCost: material.cost,
        totalValue: qty * material.cost,
        entity: requisition.brand ? `${requisition.area} (${requisition.brand})` : requisition.area,
        user: userId,
        responsible: dispatchedBy || (req.user as any)?.name,
        observation: `Requerimiento interno ${requisition._id}`,
        batchId,
      });
    }

    if (movements.length) {
      const inserted = await WarehouseMovementModel.insertMany(movements);
      // Reflejar los egresos en Contífico (solo materiales vinculados)
      const materialsById = new Map<string, any>();
      for (const item of requisition.items) {
        if (!item.material) continue;
        const mat = await RawMaterialModel.findById(item.material).lean();
        if (mat) materialsById.set(String(mat._id), mat);
      }
      await Promise.all(
        inserted.map((m: any) =>
          syncMovementToContifico({
            movementId: m._id,
            material: materialsById.get(String(m.rawMaterial)) || {},
            type: "OUT",
            quantity: m.quantity,
            description: `App Nicole — Requerimiento ${requisition.area}${requisition.brand ? ` (${requisition.brand})` : ""}`,
          })
        )
      );
    }

    requisition.status = "DISPATCHED";
    requisition.dispatchedBy = dispatchedBy || (req.user as any)?.name || "Bodega";
    requisition.dispatchedAt = new Date();
    requisition.movementBatchId = batchId;
    await requisition.save();

    return res.status(200).send({
      message: "Requerimiento despachado. Stock descontado.",
      requisition,
      movementsCreated: movements.length,
    });
  } catch (error) {
    console.error("Error dispatching requisition:", error);
    next(error);
  }
}

// --- Confirmar recepción ("firma" electrónica del solicitante) ---
export async function confirmRequisition(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const { confirmedBy, confirmationNote, items: confirmItems } = req.body;

    if (!confirmedBy) {
      return res.status(400).send({ message: "confirmedBy is required (firma de quien recibe)." });
    }

    const requisition = await InternalRequisitionModel.findById(id);
    if (!requisition) return res.status(404).send({ message: "Requisition not found." });
    if (requisition.status !== "DISPATCHED") {
      return res.status(400).send({ message: "Solo se puede confirmar un requerimiento despachado." });
    }

    if (Array.isArray(confirmItems)) {
      confirmItems.forEach((c: any) => {
        const item = requisition.items.find((i: any) => i._id?.toString() === c.itemId);
        if (item && c.itemNote) item.itemNote = c.itemNote;
      });
    }

    requisition.status = "CONFIRMED";
    requisition.confirmedBy = confirmedBy;
    requisition.confirmedAt = new Date();
    if (confirmationNote) requisition.confirmationNote = confirmationNote;
    await requisition.save();

    return res.status(200).send({ message: "Recepción confirmada.", requisition });
  } catch (error) {
    console.error("Error confirming requisition:", error);
    next(error);
  }
}
