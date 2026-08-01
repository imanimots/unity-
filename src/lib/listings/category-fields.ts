import { z } from 'zod'
import type { CategoryId } from '@/types'

/**
 * Category-specific field definitions — Phase 2A closure pass. Implements
 * the "existing 9 MVP categories only" rule (docs/LISTING_SCHEMA.md's
 * category_metadata promotion rule): only categories with a defined field
 * set below get a conditional wizard section; everything else has none.
 * `make`/`model`/`year` are deliberately NOT repeated here — they're the
 * already-existing generic `listings.brand`/`model`/`year_of_manufacture`
 * columns (see docs/LISTING_SCHEMA.md — "do not create duplicate fields
 * if an equivalent already exists").
 *
 * `public` fields are stored in `listings.category_metadata` (readable by
 * anyone). `private` fields are stored in
 * `listing_private_details.private_category_metadata` (merchant +
 * service_role only) — sensitive identifiers only.
 *
 * This is the TypeScript mirror used for wizard rendering and client-side
 * validation. The authoritative, security-relevant copy is the
 * `category_field_definitions` table (supabase/migrations/
 * 20260729000008_listing_wizard_closure.sql), which `save_listing_draft()`
 * uses to strip any key not on the allowlist — reachable directly via RPC,
 * so this TS-side validation alone is not the security boundary. Keep both
 * in sync by hand, same known-limitation pattern as the risk engine.
 */

export interface CategoryFieldDef {
  key: string
  label: string
  type: 'text' | 'select'
  options?: readonly string[]
  required?: boolean
}

export interface CategoryFieldSet {
  public: CategoryFieldDef[]
  private: CategoryFieldDef[]
}

export const CATEGORY_FIELD_SETS: Partial<Record<CategoryId, CategoryFieldSet>> = {
  vehicles: {
    public: [
      { key: 'transmission', label: 'Transmission', type: 'select', options: ['automatic', 'manual'], required: true },
      { key: 'fuel_type', label: 'Fuel type', type: 'select', options: ['petrol', 'diesel', 'electric', 'hybrid'], required: true },
      { key: 'mileage', label: 'Mileage (km)', type: 'text', required: false },
    ],
    private: [
      { key: 'vin', label: 'VIN', type: 'text', required: true },
      { key: 'registration_number', label: 'Registration number', type: 'text', required: true },
      { key: 'ownership_document_id', label: 'Ownership document reference', type: 'text', required: false },
    ],
  },
  tech: {
    public: [
      { key: 'storage_capacity', label: 'Storage capacity', type: 'text', required: false },
      { key: 'battery_condition', label: 'Battery condition', type: 'select', options: ['excellent', 'good', 'fair'], required: true },
      { key: 'charger_included', label: 'Charger included', type: 'select', options: ['yes', 'no'], required: true },
      { key: 'activation_lock_status', label: 'Activation lock status', type: 'select', options: ['unlocked', 'locked', 'not_applicable'], required: true },
    ],
    private: [
      { key: 'imei', label: 'IMEI', type: 'text', required: false },
      { key: 'serial_number', label: 'Serial number', type: 'text', required: false },
      { key: 'additional_verification_id', label: 'Additional verification reference', type: 'text', required: false },
    ],
  },
  tools: {
    public: [
      { key: 'power_source', label: 'Power source', type: 'select', options: ['mains', 'battery', 'petrol', 'manual'], required: true },
      { key: 'voltage', label: 'Voltage', type: 'text', required: false },
      { key: 'operating_capacity', label: 'Operating capacity', type: 'text', required: false },
      { key: 'safety_equipment_required', label: 'Safety equipment required', type: 'text', required: false },
    ],
    private: [],
  },
}

function fieldSetSchema(fields: CategoryFieldDef[]) {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const f of fields) {
    shape[f.key] = f.required ? z.string().min(1) : z.string().optional()
  }
  return z.object(shape).partial()
}

/** Validates a category's public category_metadata payload, dropping unknown keys. */
export function validatePublicCategoryMetadata(category: string, input: unknown): Record<string, string | undefined> {
  const set = CATEGORY_FIELD_SETS[category as CategoryId]
  if (!set) return {}
  return fieldSetSchema(set.public).parse(input ?? {}) as Record<string, string | undefined>
}

/** Validates a category's private_category_metadata payload, dropping unknown keys. */
export function validatePrivateCategoryMetadata(category: string, input: unknown): Record<string, string | undefined> {
  const set = CATEGORY_FIELD_SETS[category as CategoryId]
  if (!set) return {}
  return fieldSetSchema(set.private).parse(input ?? {}) as Record<string, string | undefined>
}

/** Every required public+private field key for a category — used by the completeness engine. */
export function getRequiredCategoryFieldKeys(category: string): string[] {
  const set = CATEGORY_FIELD_SETS[category as CategoryId]
  if (!set) return []
  return [...set.public, ...set.private].filter((f) => f.required).map((f) => f.key)
}

/** True if a category has any defined field set at all (drives whether the wizard shows the section). */
export function hasCategoryFields(category: string): boolean {
  return !!CATEGORY_FIELD_SETS[category as CategoryId]
}
