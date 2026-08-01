import { describe, it, expect } from 'vitest'
import { validatePublicCategoryMetadata, validatePrivateCategoryMetadata, CATEGORY_FIELD_SETS, getRequiredCategoryFieldKeys, hasCategoryFields } from '../category-fields'

describe('category-specific field definitions', () => {
  it('only defines field sets for the categories explicitly named in the spec', () => {
    expect(Object.keys(CATEGORY_FIELD_SETS).sort()).toEqual(['tech', 'tools', 'vehicles'])
  })

  it('never puts a sensitive identifier in the public field set', () => {
    const publicKeys = Object.values(CATEGORY_FIELD_SETS).flatMap((s) => s!.public.map((f) => f.key))
    for (const sensitive of ['vin', 'imei', 'registration_number']) {
      expect(publicKeys).not.toContain(sensitive)
    }
  })

  it('vehicles: VIN and registration number are private only', () => {
    const set = CATEGORY_FIELD_SETS.vehicles!
    expect(set.private.map((f) => f.key)).toEqual(expect.arrayContaining(['vin', 'registration_number']))
    expect(set.public.map((f) => f.key)).not.toContain('vin')
  })

  it('validates and strips unknown keys from a category metadata payload', () => {
    const result = validatePublicCategoryMetadata('vehicles', { transmission: 'automatic', hacked_field: 'x' })
    expect(result.transmission).toBe('automatic')
    expect(result).not.toHaveProperty('hacked_field')
  })

  it('returns an empty object for a category with no defined field set', () => {
    expect(validatePublicCategoryMetadata('outdoor', { anything: 'x' })).toEqual({})
    expect(validatePrivateCategoryMetadata('outdoor', { anything: 'x' })).toEqual({})
  })

  it('validates private metadata separately from public', () => {
    const result = validatePrivateCategoryMetadata('tech', { imei: '123456789012345' })
    expect(result.imei).toBe('123456789012345')
  })

  it('lists required fields per category, spanning both public and private', () => {
    const required = getRequiredCategoryFieldKeys('vehicles')
    expect(required).toEqual(expect.arrayContaining(['transmission', 'fuel_type', 'vin', 'registration_number']))
    expect(required).not.toContain('mileage') // optional
  })

  it('hasCategoryFields reflects only the 3 categories with a defined set', () => {
    expect(hasCategoryFields('vehicles')).toBe(true)
    expect(hasCategoryFields('outdoor')).toBe(false)
  })

  // "Switching category safely clears incompatible metadata" — simulates
  // the wizard's category-change flow: values entered under the OLD
  // category must not survive being re-validated against the NEW one.
  it('re-validating a payload against a different category drops the old category-specific keys', () => {
    const enteredUnderVehicles = { transmission: 'automatic', fuel_type: 'petrol' }
    const revalidatedAsTech = validatePublicCategoryMetadata('tech', enteredUnderVehicles)
    expect(revalidatedAsTech).toEqual({})
  })

  it('re-validating private metadata against a different category drops stale sensitive values too', () => {
    const enteredUnderVehicles = { vin: '1HGCM82633A004352' }
    const revalidatedAsTech = validatePrivateCategoryMetadata('tech', enteredUnderVehicles)
    expect(revalidatedAsTech).toEqual({})
  })
})
