export type ClinicLocationStatus = 'configured' | 'addressOnly' | 'pending';

export interface ResolvedClinicLocation {
  id: string | null;
  clinicId: string | null;
  clinicName: string | null;
  formattedAddress: string | null;
  landmark: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  source: string | null;
  locationStatus: ClinicLocationStatus;
  hasValidCoordinates: boolean;
}

export interface DoctorLocationInput {
  clinicId?: string | null;
  clinicName?: string | null;
  clinic?: {
    id: string;
    name: string;
    formattedAddress: string;
    landmark: string | null;
    phone: string | null;
    latitude: number | null;
    longitude: number | null;
    accuracyMeters: number | null;
    source: string;
  } | null;
  clinicLocations?: Array<{
    id: string;
    clinicName: string | null;
    formattedAddress: string | null;
    latitude: number | null;
    longitude: number | null;
    accuracyMeters: number | null;
    source: string;
    status: string;
    isCurrent: boolean;
  }>;
}

export function isValidCoordinatePair(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  if (latitude == null || longitude == null) {
    return false;
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return false;
  }
  if (latitude === 0 && longitude === 0) {
    return false;
  }
  return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

/**
 * Single authoritative clinic-location status resolver used by every HC and MR endpoint.
 * Never infers location status from `clinicName` alone.
 *
 * Precedence:
 * 1. Current `DoctorClinicLocation` (`isCurrent = true`), falling back to
 * 2. Linked `Clinic` record (`doctor.clinic`).
 */
export function resolveDoctorClinicLocation(
  doctor: DoctorLocationInput,
): ResolvedClinicLocation {
  const currentLoc =
    doctor.clinicLocations?.find((l) => l.isCurrent) ??
    doctor.clinicLocations?.[0] ??
    null;
  const clinic = doctor.clinic ?? null;

  const locHasCoords = isValidCoordinatePair(
    currentLoc?.latitude,
    currentLoc?.longitude,
  );
  const clinicHasCoords = isValidCoordinatePair(
    clinic?.latitude,
    clinic?.longitude,
  );

  const latitude = locHasCoords
    ? currentLoc!.latitude!
    : clinicHasCoords
      ? clinic!.latitude!
      : null;
  const longitude = locHasCoords
    ? currentLoc!.longitude!
    : clinicHasCoords
      ? clinic!.longitude!
      : null;
  const accuracyMeters = locHasCoords
    ? (currentLoc?.accuracyMeters ?? null)
    : clinicHasCoords
      ? (clinic?.accuracyMeters ?? null)
      : null;

  const formattedAddress =
    (currentLoc?.formattedAddress?.trim() || null) ??
    (clinic?.formattedAddress?.trim() || null);
  const clinicName =
    (currentLoc?.clinicName?.trim() || null) ??
    (clinic?.name?.trim() || null) ??
    (doctor.clinicName?.trim() || null);
  const source =
    (locHasCoords ? currentLoc?.source : null) ??
    (clinicHasCoords ? clinic?.source : null) ??
    currentLoc?.source ??
    clinic?.source ??
    null;

  const hasValidCoordinates = isValidCoordinatePair(latitude, longitude);
  const hasAddress =
    typeof formattedAddress === 'string' && formattedAddress.length >= 5;

  let locationStatus: ClinicLocationStatus = 'pending';
  if (hasValidCoordinates) {
    locationStatus = 'configured';
  } else if (hasAddress) {
    locationStatus = 'addressOnly';
  }

  return {
    id: currentLoc?.id ?? null,
    clinicId: clinic?.id ?? doctor.clinicId ?? null,
    clinicName,
    formattedAddress,
    landmark: clinic?.landmark ?? null,
    phone: clinic?.phone ?? null,
    latitude,
    longitude,
    accuracyMeters,
    source,
    locationStatus,
    hasValidCoordinates,
  };
}
