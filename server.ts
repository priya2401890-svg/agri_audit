import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';
import { dbManager, FarmRegistrationError, ClaimSubmissionError } from './src/server/db';
import { INDIAN_LOCATIONS } from './src/data/locations';
import { FarmBoundary, GpsTrackPoint, LandDocument, LandDocumentOcrFields, User } from './src/types';
import { filterGpsTrack, processFarmPolygon, processGpsTrackPolygon } from './src/services/gis/gpsProcessing';
import { MAX_LAND_DOCUMENT_BYTES } from './src/config/landDocumentConfig';
import { landDocumentOcrProvider } from './src/services/landDocumentOcrProvider';
import { validateLandDocumentUpload } from './src/services/landDocumentUploadService';
import { evaluateEvidenceQuality } from './src/services/evidenceQualityService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isProd = process.env.NODE_ENV === 'production';
const LAND_DOCUMENT_STORAGE_DIR = path.resolve(
  process.env.LAND_DOCUMENT_STORAGE_DIR || path.join(process.cwd(), 'private_uploads', 'land-documents')
);
const configuredLandDocumentBytes = Number(process.env.VITE_LAND_DOCUMENT_MAX_BYTES);
const LAND_DOCUMENT_BODY_LIMIT =
  Number.isFinite(configuredLandDocumentBytes) && configuredLandDocumentBytes > 0
    ? configuredLandDocumentBytes
    : MAX_LAND_DOCUMENT_BYTES;

function isGpsTrackPoint(value: unknown): value is GpsTrackPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as Partial<GpsTrackPoint>;
  const optionalNumberIsValid = (number: number | null | undefined) =>
    number === undefined || number === null || (typeof number === 'number' && Number.isFinite(number));
  return (
    typeof point.lat === 'number' &&
    typeof point.lng === 'number' &&
    typeof point.accuracy === 'number' &&
    typeof point.timestamp === 'string' &&
    optionalNumberIsValid(point.altitude) &&
    optionalNumberIsValid(point.speed) &&
    optionalNumberIsValid(point.heading)
  );
}

app.use(express.json({ limit: '10mb' }));

// Helper to extract session user from header
function getAuthUser(req: Request) {
  const authHeader = req.headers['x-user-id'] as string;
  if (!authHeader) return null;
  return dbManager.findUserById(authHeader);
}

// ---------------- API Routes ----------------

// Locations hierarchy
app.get('/api/locations', (_req: Request, res: Response) => {
  res.json({ success: true, data: INDIAN_LOCATIONS });
});

// App & Mobile Info
app.get('/api/app-info', (_req: Request, res: Response) => {
  const publicUrl = process.env.APP_URL || 'https://ais-dev-g3tr6agze6pxvzpontsjw2-765918770461.asia-east1.run.app';
  res.json({
    success: true,
    appUrl: publicUrl,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Auth: Login
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { role, identifier, password } = req.body;
  if (!role || !identifier) {
    return res.status(400).json({ success: false, message: 'Role and login identifier are required' });
  }

  // Predefined role checks
  if (role === 'admin') {
    // Expected admin
    const user = dbManager.findUserByCredentials('admin', identifier);
    if (!user || (password && password !== 'admin123')) {
      return res.status(401).json({ success: false, message: 'Invalid Admin credentials' });
    }
    return res.json({ success: true, user, role: 'admin' });
  }

  if (role === 'officer') {
    const user = dbManager.findUserByCredentials('officer', identifier);
    if (!user || (password && password !== 'officer123')) {
      return res.status(401).json({ success: false, message: 'Invalid Government Officer credentials' });
    }
    return res.json({ success: true, user, role: 'officer' });
  }

  if (role === 'farmer') {
    const user = dbManager.findUserByCredentials('farmer', identifier);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Farmer record not found. Please register first.' });
    }
    const farmer = dbManager.getFarmerByUserId(user.id);
    return res.json({ success: true, user, farmer, role: 'farmer' });
  }

  return res.status(400).json({ success: false, message: 'Unsupported user role' });
});

// Auth: Public list of registered farmers for quick login
app.get('/api/auth/farmers', (_req: Request, res: Response) => {
  const farmers = dbManager.getDb().farmers.map(f => ({
    id: f.id,
    name: f.name,
    phone: f.phone,
    state: f.state,
    district: f.district,
    village: f.village,
    governmentId: f.governmentId
  }));
  res.json({ success: true, data: farmers });
});

// Auth: Direct Session loader for QR scan
app.get('/api/auth/farmer-session/:farmerId', (req: Request, res: Response) => {
  const { farmerId } = req.params;
  const db = dbManager.getDb();
  let farmer = db.farmers.find(f => f.id === farmerId);
  if (!farmer && db.farmers.length > 0) {
    farmer = db.farmers[0];
  }
  if (!farmer) {
    return res.status(404).json({ success: false, message: 'Farmer not found' });
  }
  let user = db.users.find(u => u.id === farmer.userId);
  if (!user) {
    user = {
      id: farmer.userId || `usr_${farmer.id}`,
      name: farmer.name,
      phone: farmer.phone || '9876543210',
      role: 'farmer',
      createdAt: new Date().toISOString()
    };
  }
  res.json({ success: true, user, farmer, role: 'farmer' });
});

// Auth: Farmer Registration
app.post('/api/auth/register-farmer', (req: Request, res: Response) => {
  const { name, phone, email, governmentId, photoUrl, state, district, village, address, bankDetails } = req.body;

  if (!name || !phone || !governmentId || !state || !district || !village) {
    return res.status(400).json({
      success: false,
      message: 'Name, phone, government ID, state, district, and village are mandatory.'
    });
  }

  // Check if phone or govtId already registered
  const existingUser = dbManager.findUserByCredentials('farmer', phone);
  if (existingUser) {
    return res.status(409).json({ success: false, message: 'A farmer with this phone number already exists.' });
  }

  const { user, farmer } = dbManager.registerFarmer({
    name,
    phone,
    email: email || '',
    governmentId,
    photoUrl: photoUrl || '',
    state,
    district,
    village,
    address: address || `${village}, ${district}, ${state}`,
    bankDetails: bankDetails || {
      accountNo: '3000' + Math.floor(10000000 + Math.random() * 90000000),
      ifsc: 'SBIN0001234',
      bankName: 'State Bank of India',
      branch: `${district} Rural Mandi`,
      holderName: name
    }
  });

  res.status(201).json({ success: true, user, farmer });
});

// Current User Profile
app.get('/api/auth/me', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  let farmer = undefined;
  if (user.role === 'farmer') {
    farmer = dbManager.getFarmerByUserId(user.id);
  }
  res.json({ success: true, user, farmer });
});

// Farms
app.get('/api/farms', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  if (user.role === 'farmer') {
    const farmer = dbManager.getFarmerByUserId(user.id);
    if (!farmer) return res.json({ success: true, data: [] });
    // Farmers see ONLY their own farm boundaries
    const farms = dbManager.getFarms(farmer.id);
    return res.json({ success: true, data: farms });
  }

  // Admin & Officer can view all farms
  const farms = dbManager.getFarms();
  res.json({ success: true, data: farms });
});

app.post('/api/farms', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const farmer = user.role === 'farmer'
    ? dbManager.getFarmerByUserId(user.id)
    : dbManager.getDb().farmers.find(profile => profile.id === req.body.farmerId);
  if (!farmer) {
    return res.status(user.role === 'farmer' ? 404 : 400).json({
      success: false,
      message: user.role === 'farmer' ? 'Farmer profile not found.' : 'Select a registered farmer before saving a farm.'
    });
  }
  if (req.body.farmerId !== undefined && req.body.farmerId !== farmer.id) {
    return res.status(403).json({ success: false, message: 'You can only register lands in your own account.' });
  }

  const farmId = typeof req.body.farmId === 'string' ? req.body.farmId : undefined;
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const khasraSurveyNo = typeof req.body.khasraSurveyNo === 'string'
    ? req.body.khasraSurveyNo.trim()
    : '';
  if (!name || !khasraSurveyNo) {
    return res.status(400).json({ success: false, message: 'Farm name and land survey number are required.' });
  }

  const polygonCoordinates: unknown = req.body.polygonCoordinates;
  if (
    !Array.isArray(polygonCoordinates) ||
    polygonCoordinates.length < 3 ||
    !polygonCoordinates.every(
      (point: unknown) =>
        Array.isArray(point) &&
        point.length === 2 &&
        typeof point[0] === 'number' &&
        Number.isFinite(point[0]) &&
        typeof point[1] === 'number' &&
        Number.isFinite(point[1])
    )
  ) {
    return res.status(400).json({ success: false, message: 'The farm boundary is invalid. Please redraw the boundary.' });
  }

  const geometry = processFarmPolygon(polygonCoordinates);
  if (!geometry.valid) {
    return res.status(400).json({ success: false, message: 'The farm boundary is invalid. Please redraw the boundary.' });
  }

  let gpsTrackFields: Pick<FarmBoundary, 'rawGpsTrack' | 'filteredGpsTrack' | 'gpsQuality' | 'dataMode'> = {
    dataMode: 'REAL'
  };
  if (req.body.rawGpsTrack !== undefined) {
    if (
      !Array.isArray(req.body.rawGpsTrack) ||
      req.body.rawGpsTrack.length > 20000 ||
      !req.body.rawGpsTrack.every(isGpsTrackPoint)
    ) {
      return res.status(400).json({ success: false, message: 'The submitted raw GPS track is invalid or too large.' });
    }
    const rawGpsTrack = req.body.rawGpsTrack as GpsTrackPoint[];
    const filtered = filterGpsTrack(rawGpsTrack);
    const trackGeometry = processGpsTrackPolygon(rawGpsTrack);
    if (!trackGeometry.valid) {
      return res.status(400).json({
        success: false,
        message: 'GPS accuracy is too low to safely save this farm boundary. Please move to an open area and try again.'
      });
    }
    if (
      trackGeometry.polygonCoordinates.length !== geometry.polygonCoordinates.length ||
      trackGeometry.polygonCoordinates.some(
        ([lat, lng], index) =>
          Math.abs(lat - geometry.polygonCoordinates[index][0]) > 0.000001 ||
          Math.abs(lng - geometry.polygonCoordinates[index][1]) > 0.000001
      )
    ) {
      return res.status(400).json({
        success: false,
        message: 'The farm polygon must match the validated GPS track.'
      });
    }
    gpsTrackFields = {
      rawGpsTrack,
      filteredGpsTrack: filtered.filteredGpsTrack,
      gpsQuality: filtered.quality,
      dataMode: 'REAL'
    };
  }
  if (req.body.boundaryType === 'gps_walk' && !gpsTrackFields.rawGpsTrack?.length) {
    return res.status(400).json({
      success: false,
      message: 'GPS accuracy is too low to safely save this farm boundary. Please move to an open area and try again.'
    });
  }

  const farmData: Omit<FarmBoundary, 'id' | 'createdAt'> = {
    farmerId: farmer.id,
    farmerName: farmer.name,
    name,
    khasraSurveyNo,
    state: farmer.state,
    district: farmer.district,
    village: farmer.village,
    areaAcres: geometry.areaAcres,
    areaHectares: geometry.areaHectares,
    centerLat: geometry.centroid?.[0] ?? 0,
    centerLng: geometry.centroid?.[1] ?? 0,
    polygonCoordinates: geometry.polygonCoordinates.slice(0, -1),
    boundaryType: req.body.boundaryType === 'gps_walk' ? 'gps_walk' : 'manual',
    ...gpsTrackFields,
    polygonValidation: { valid: true, warnings: geometry.warnings, errors: [] }
  };

  try {
    const savedFarm = farmId
      ? dbManager.updateFarm(farmId, farmData, user)
      : dbManager.addFarm(farmData, user);
    return res.status(farmId ? 200 : 201).json({ success: true, data: savedFarm });
  } catch (error) {
    if (error instanceof FarmRegistrationError) {
      const status = ['MAX_LAND_LIMIT_REACHED', 'DUPLICATE_LAND_DETECTED'].includes(error.code)
        ? 409
        : error.code === 'FARM_OWNERSHIP_MISMATCH'
        ? 403
        : error.code === 'FARM_NOT_FOUND'
        ? 404
        : 400;
      return res.status(status).json({ success: false, message: error.message, code: error.code });
    }
    console.error('Farm registration failed:', error);
    return res.status(500).json({ success: false, message: 'Farm could not be saved.' });
  }
});

// Insurance Policies
app.get('/api/policies', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  if (user.role === 'farmer') {
    const farmer = dbManager.getFarmerByUserId(user.id);
    if (!farmer) return res.json({ success: true, data: [] });
    return res.json({ success: true, data: dbManager.getPolicies(farmer.id) });
  }

  res.json({ success: true, data: dbManager.getPolicies() });
});

// Claims: GET List
app.get('/api/claims', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { status, search } = req.query as { status?: string; search?: string };

  if (user.role === 'farmer') {
    const farmer = dbManager.getFarmerByUserId(user.id);
    if (!farmer) return res.json({ success: true, data: [] });
    const claims = dbManager.getClaims({ farmerId: farmer.id, status, search });
    // Farmers ONLY see simplified status and no technical satellite/ML payload
    const sanitized = claims.map(c => ({
      id: c.id,
      claimNumber: c.claimNumber,
      farmName: c.farmName,
      khasraSurveyNo: c.khasraSurveyNo,
      crop: c.crop,
      season: c.season,
      damageType: c.damageType,
      damageDate: c.damageDate,
      claimAmountRequested: c.claimAmountRequested,
      status: c.status,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    }));
    return res.json({ success: true, data: sanitized });
  }

  // Admin and Government Officer get full claims
  const claims = dbManager.getClaims({ status, search });
  res.json({ success: true, data: claims });
});

// Claim Detail
app.get('/api/claims/:id', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const claim = dbManager.getClaimById(req.params.id);
  if (!claim) {
    return res.status(404).json({ success: false, message: 'Claim not found' });
  }

  // If farmer, ensure ownership and sanitize
  if (user.role === 'farmer') {
    const farmer = dbManager.getFarmerByUserId(user.id);
    if (!farmer || claim.farmerId !== farmer.id) {
      return res.status(403).json({ success: false, message: 'Access denied to this claim' });
    }
    const decision = dbManager.getDecision(claim.id);
    return res.json({
      success: true,
      data: {
        ...claim,
        decision: decision ? {
          decision: decision.decision,
          approvedCompensationInr: decision.approvedCompensationInr,
          remarks: decision.remarks,
          decisionDate: decision.decisionDate,
          approvalOrderNumber: decision.approvalOrderNumber
        } : null
      }
    });
  }

  // Admin & Officer: return complete dossier with satellite, ML, decision, reconsideration
  const satelliteData = dbManager.getSatelliteData(claim.id);
  const mlAssessment = dbManager.getMLAssessment(claim.id);
  const decision = dbManager.getDecision(claim.id);
  const reconsideration = dbManager.getReconsideration(claim.id);
  const farm = dbManager.getFarms().find(f => f.id === claim.farmBoundaryId);
  const farmer = dbManager.getDb().farmers.find(f => f.id === claim.farmerId);

  let reconciliation = null;
  let registryParcel = null;
  if (farm) {
    reconciliation = dbManager.getReconciliationByFarmId(farm.id, undefined, user);
    if (reconciliation) {
      registryParcel = dbManager.getRegistryParcelByKhasra(reconciliation.khasraSurveyNo);
    } else {
      registryParcel = dbManager.getRegistryParcelByKhasra(farm.khasraSurveyNo);
    }
  }
  const landDocuments = dbManager.getLandDocuments(claim.farmerId);
  const evidenceQuality = evaluateEvidenceQuality({
    farm,
    registryParcel,
    landDocuments,
    satelliteData,
    mlAssessment
  });
  dbManager.saveClaimEvidenceQuality(claim.id, evidenceQuality);

  res.json({
    success: true,
    data: {
      ...claim,
      farmer,
      farm,
      reconciliation,
      registryParcel,
      landDocuments: landDocuments.map(publicLandDocument),
      evidenceQuality,
      satelliteData,
      mlAssessment,
      decision,
      reconsideration
    }
  });
});

// =================================================================
// MODULE 05: RECONCILIATION API (Registry vs Farmer GPS Polygon)
// =================================================================

// Detailed Reconciliation (Restricted to Admin and Government Officer)
app.get('/api/reconciliation/:farmId', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  // Security Rule: Detailed reconciliation data is strictly restricted to Admin and Government Officers
  if (user.role !== 'admin' && user.role !== 'officer') {
    return res.status(403).json({
      success: false,
      message: 'Access Forbidden: Detailed land registry reconciliation data is restricted to authorized Government Officers and Nodal Administrators.'
    });
  }

  const record = dbManager.getReconciliationByFarmId(req.params.farmId, undefined, user);
  if (!record) {
    return res.status(404).json({ success: false, message: 'Farm parcel not found for reconciliation.' });
  }

  const registryParcel = dbManager.getRegistryParcelByKhasra(record.khasraSurveyNo);
  res.json({
    success: true,
    data: record,
    registryParcel
  });
});

// Re-calculate / Re-calibrate Reconciliation with custom thresholds (Admin & Officer only)
app.post('/api/reconciliation/:farmId/recompute', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  if (user.role !== 'admin' && user.role !== 'officer') {
    return res.status(403).json({
      success: false,
      message: 'Access Forbidden: Only Administrators and Officers can re-calibrate reconciliation parameters.'
    });
  }

  try {
    const { config } = req.body;
    const record = dbManager.reconcileFarmGeometry(req.params.farmId, config, user);
    const registryParcel = dbManager.getRegistryParcelByKhasra(record.khasraSurveyNo);

    res.json({
      success: true,
      data: record,
      registryParcel
    });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message || 'Reconciliation failed' });
  }
});

// High-level farmer verification status (Permitted for Farmers, without exposing sensitive registry records)
app.get('/api/reconciliation/status/:farmId', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const farm = dbManager.getDb().farms.find(f => f.id === req.params.farmId);
  if (!farm) {
    return res.status(404).json({ success: false, message: 'Farm parcel not found' });
  }

  // If role is farmer, verify ownership
  if (user.role === 'farmer') {
    const farmer = dbManager.getFarmerByUserId(user.id);
    if (!farmer || farm.farmerId !== farmer.id) {
      return res.status(403).json({ success: false, message: 'Access Forbidden to this farm parcel' });
    }
  }

  let statusText = 'Boundary verification in progress';
  if (farm.reconciliationStatus === 'verified_match') {
    statusText = 'Boundary verification completed';
  } else if (farm.reconciliationStatus === 'mismatch_detected') {
    statusText = 'Boundary mismatch detected — please contact the relevant authority.';
  }

  res.json({
    success: true,
    data: {
      farmId: farm.id,
      farmName: farm.name,
      khasraSurveyNo: farm.khasraSurveyNo,
      verificationStatus: statusText,
      statusCode: farm.reconciliationStatus || 'in_progress',
      updatedAt: farm.createdAt
    }
  });
});

// Official Registry Parcels (Restricted to Admin & Officer)
app.get('/api/registry-parcels', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== 'admin' && user.role !== 'officer')) {
    return res.status(403).json({ success: false, message: 'Access Forbidden: Land records registry is restricted.' });
  }
  res.json({ success: true, data: dbManager.getRegistryParcels() });
});

function publicLandDocument(document: LandDocument) {
  const { storageReference: _storageReference, ...publicRecord } = document;
  return publicRecord;
}

app.get('/api/land-documents', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const farmer = user.role === 'farmer' ? dbManager.getFarmerByUserId(user.id) : undefined;
  if (user.role === 'farmer' && !farmer) {
    return res.status(404).json({ success: false, message: 'Farmer profile not found.' });
  }
  const records = dbManager.getLandDocuments(farmer?.id).map(publicLandDocument);
  res.json({ success: true, data: records });
});

app.post(
  '/api/land-documents',
  express.raw({ type: '*/*', limit: `${LAND_DOCUMENT_BODY_LIMIT}b` }),
  async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    if (!user || user.role !== 'farmer') {
      return res.status(403).json({ success: false, message: 'Only authenticated farmers may upload land documents.' });
    }
    const farmer = dbManager.getFarmerByUserId(user.id);
    if (!farmer) {
      return res.status(404).json({ success: false, message: 'Farmer profile not found.' });
    }
    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).json({ success: false, message: 'Upload the document as a binary file body.' });
    }

    const encodedFileName = req.headers['x-file-name'];
    const contentType = req.headers['content-type'];
    if (typeof encodedFileName !== 'string' || typeof contentType !== 'string') {
      return res.status(400).json({ success: false, message: 'File name and MIME type are required.' });
    }

    let decodedFileName: string;
    try {
      decodedFileName = decodeURIComponent(encodedFileName);
    } catch {
      return res.status(400).json({ success: false, message: 'File name encoding is invalid.' });
    }
    const fileName = path.basename(decodedFileName).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
    const validationError = validateLandDocumentUpload(fileName, contentType, req.body.length, LAND_DOCUMENT_BODY_LIMIT);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const documentId = `landdoc_${randomUUID()}`;
    const extension = path.extname(fileName).toLowerCase();
    const storageName = `${documentId}${extension}`;
    const storagePath = path.resolve(LAND_DOCUMENT_STORAGE_DIR, storageName);
    if (!storagePath.startsWith(`${LAND_DOCUMENT_STORAGE_DIR}${path.sep}`)) {
      return res.status(400).json({ success: false, message: 'Invalid document file name.' });
    }

    try {
      await fs.mkdir(LAND_DOCUMENT_STORAGE_DIR, { recursive: true });
      await fs.writeFile(storagePath, req.body, { flag: 'wx' });
      const ocrResult = await landDocumentOcrProvider.extract({
        documentId,
        mimeType: contentType,
        content: req.body,
        languageHints: ['en', 'bn']
      });
      const document: LandDocument = {
        id: documentId,
        farmerId: farmer.id,
        fileName,
        mimeType: contentType,
        fileSize: req.body.length,
        storageReference: `land-documents/${storageName}`,
        ocrStatus: ocrResult.status,
        ocrResult,
        createdAt: new Date().toISOString()
      };
      dbManager.addLandDocument(document, user);
      return res.status(201).json({ success: true, data: publicLandDocument(document) });
    } catch (error) {
      try {
        await fs.unlink(storagePath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('Failed to remove incomplete land document upload:', cleanupError);
        }
      }
      console.error('Land document upload failed:', error);
      return res.status(500).json({ success: false, message: 'Document could not be stored or processed.' });
    }
  }
);

app.post('/api/land-documents/:id/confirm', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const document = dbManager.getLandDocument(req.params.id);
  if (!document) return res.status(404).json({ success: false, message: 'Land document not found.' });

  if (user.role === 'farmer') {
    const farmer = dbManager.getFarmerByUserId(user.id);
    if (!farmer || farmer.id !== document.farmerId) {
      return res.status(403).json({ success: false, message: 'Access denied to this land document.' });
    }
  }

  const fields = req.body?.fields;
  const fieldNames: (keyof LandDocumentOcrFields)[] = [
    'district', 'block', 'mouza', 'jlNumber', 'dagNumber', 'khatianNumber',
    'ownerName', 'plotArea', 'plotAreaUnit', 'share', 'documentReferenceNumber'
  ];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return res.status(400).json({ success: false, message: 'Confirmed land document fields are required.' });
  }

  const confirmedFields = {} as LandDocumentOcrFields;
  for (const fieldName of fieldNames) {
    const value: unknown = fields[fieldName];
    if (fieldName === 'plotArea') {
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        return res.status(400).json({ success: false, message: 'Plot area must be a non-negative number or null.' });
      }
      confirmedFields.plotArea = value as number | null;
    } else {
      if (value !== null && (typeof value !== 'string' || value.length > 500)) {
        return res.status(400).json({ success: false, message: `Invalid ${fieldName} value.` });
      }
      confirmedFields[fieldName] = value as string | null;
    }
  }
  if (!fieldNames.some(fieldName => confirmedFields[fieldName] !== null)) {
    return res.status(400).json({ success: false, message: 'Enter at least one land identifier before confirming.' });
  }

  const updated = dbManager.confirmLandDocumentFields(document.id, confirmedFields, user);
  if (!updated) return res.status(404).json({ success: false, message: 'Land document not found.' });
  return res.json({ success: true, data: publicLandDocument(updated) });
});

// Submit Claim (Farmer)
app.post('/api/claims', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user || user.role !== 'farmer') {
    return res.status(401).json({ success: false, message: 'Sign in as a farmer to submit a claim.' });
  }
  const farmer = dbManager.getFarmerByUserId(user.id);
  if (!farmer) return res.status(404).json({ success: false, message: 'Farmer profile not found.' });
  if (req.body.farmerId !== undefined && req.body.farmerId !== farmer.id) {
    dbManager.logRejectedClaimSubmission(user, String(req.body.farmerId), String(req.body.farmBoundaryId || ''), 'FARM_OWNERSHIP_MISMATCH');
    return res.status(403).json({ success: false, message: 'You can only submit claims for your own farm.' });
  }

  let {
    farmBoundaryId,
    insurancePolicyId,
    crop,
    season,
    damageType,
    damageDate,
    description,
    evidencePhotos,
    claimAmountRequested
  } = req.body;

  if (typeof farmBoundaryId !== 'string' || !farmBoundaryId) {
    dbManager.logRejectedClaimSubmission(user, farmer.id, '', 'FARM_NOT_FOUND');
    return res.status(400).json({ success: false, message: 'Select a registered farm before submitting a claim.' });
  }
  const farm = dbManager.getFarms().find(existing => existing.id === farmBoundaryId);
  if (!farm) {
    dbManager.logRejectedClaimSubmission(user, farmer.id, farmBoundaryId, 'FARM_NOT_FOUND');
    return res.status(404).json({ success: false, message: 'Select a registered farm before submitting a claim.' });
  }
  if (farm.farmerId !== farmer.id) {
    dbManager.logRejectedClaimSubmission(user, farmer.id, farmBoundaryId, 'FARM_OWNERSHIP_MISMATCH');
    return res.status(403).json({ success: false, message: 'The selected farm does not belong to your account.' });
  }
  if (!processFarmPolygon(farm.polygonCoordinates).valid) {
    dbManager.logRejectedClaimSubmission(user, farmer.id, farmBoundaryId, 'INVALID_FARM_BOUNDARY');
    return res.status(400).json({ success: false, message: 'The selected farm boundary is invalid and cannot be used for a claim.' });
  }

  try {
    dbManager.assertClaimLimit(user, farmer, farmBoundaryId);
  } catch (error) {
    if (error instanceof ClaimSubmissionError) {
      const status = error.code === 'MAX_CLAIM_LIMIT_REACHED'
        ? 409
        : error.code === 'FARM_OWNERSHIP_MISMATCH'
        ? 403
        : 400;
      return res.status(status).json({ success: false, message: error.message, code: error.code });
    }
    console.error('Claim limit validation failed:', error);
    return res.status(500).json({ success: false, message: 'Claim could not be submitted.' });
  }

  // Auto-resolve or issue linked insurance policy
  if (!insurancePolicyId) {
    const policies = dbManager.getPolicies(farmer.id);
    if (policies.length > 0) {
      insurancePolicyId = policies[0].id;
    } else {
      const newPol = dbManager.addPolicy({
        farmerId: farmer.id,
        provider: 'Agriculture Insurance Company of India (AIC)',
        scheme: 'PMFBY (Pradhan Mantri Fasal Bima Yojana)',
        policyNumber: `PMFBY-${farmer.state.slice(0, 2).toUpperCase()}-${Date.now().toString().slice(-6)}`,
        crop: crop || 'Paddy (Basmati)',
        season: season || 'Kharif 2026',
        insuredAreaAcres: 4.0,
        insuredAmountInr: 120000,
        premiumInr: 2400,
        startDate: '2026-06-01',
        endDate: '2026-12-31',
        status: 'Active'
      }, user);
      insurancePolicyId = newPol.id;
    }
  }

  try {
    const claim = dbManager.createClaim(
      {
      farmerId: farmer.id,
      farmBoundaryId,
      insurancePolicyId: insurancePolicyId || '',
      crop: crop || 'Paddy (Basmati)',
      season: season || 'Kharif 2026',
      damageType: damageType || 'Flood',
      damageDate: damageDate || new Date().toISOString().split('T')[0],
      description: description || `Crop damage loss intimation filed via Agri-Audit portal.`,
      evidencePhotos: evidencePhotos || ['/src/assets/images/indian_farmer_field_1790829345974.jpg'],
      claimAmountRequested: Number(claimAmountRequested) || 75000
      },
      user
    );
    return res.status(201).json({ success: true, data: claim });
  } catch (error) {
    if (error instanceof ClaimSubmissionError) {
      const status = error.code === 'MAX_CLAIM_LIMIT_REACHED'
        ? 409
        : error.code === 'FARM_OWNERSHIP_MISMATCH' || error.code === 'POLICY_OWNERSHIP_MISMATCH'
        ? 403
        : error.code === 'FARM_NOT_FOUND'
        ? 404
        : 400;
      return res.status(status).json({ success: false, message: error.message, code: error.code });
    }
    console.error('Claim submission failed:', error);
    return res.status(500).json({ success: false, message: 'Claim could not be submitted.' });
  }
});

// Satellite + ML Analysis API (Admin & Officer only)
app.get('/api/claims/:id/satellite-analysis', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== 'admin' && user.role !== 'officer')) {
    return res.status(403).json({
      success: false,
      message: 'Access restricted: Satellite and ML assessment is restricted to District Admins and Government Officers.'
    });
  }

  const claim = dbManager.getClaimById(req.params.id);
  if (!claim) {
    return res.status(404).json({ success: false, message: 'Claim not found' });
  }

  const satelliteData = dbManager.getSatelliteData(claim.id);
  const mlAssessment = dbManager.getMLAssessment(claim.id);
  const farm = dbManager.getFarms().find(f => f.id === claim.farmBoundaryId);

  res.json({
    success: true,
    data: {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      crop: claim.crop,
      damageType: claim.damageType,
      farm,
      satelliteData,
      mlAssessment
    }
  });
});

// Admin Review Submission
app.post('/api/claims/:id/admin-review', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Only Admins can perform admin review' });
  }

  const { notes } = req.body;
  try {
    const result = dbManager.submitAdminReview(req.params.id, notes || 'Verified with Sentinel-1/2 data', user);
    res.json({ success: true, data: result.claim });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Government Officer Decision
app.post('/api/claims/:id/govt-decision', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user || user.role !== 'officer') {
    return res.status(403).json({ success: false, message: 'Only Government Officers can make final claim decisions' });
  }

  const { decision, approvedCompensationInr, remarks, rejectionReason } = req.body;

  if (!decision || (decision !== 'Approved' && decision !== 'Rejected')) {
    return res.status(400).json({ success: false, message: 'Decision must be Approved or Rejected' });
  }

  if (decision === 'Rejected' && !rejectionReason?.trim()) {
    return res.status(400).json({ success: false, message: 'Rejection reason is mandatory when rejecting a claim.' });
  }

  try {
    const decisionRecord = dbManager.submitGovtDecision(
      req.params.id,
      {
        decision,
        approvedCompensationInr: Number(approvedCompensationInr) || 0,
        remarks: remarks || '',
        rejectionReason
      },
      user
    );
    res.json({ success: true, data: decisionRecord });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Reconsideration Request (Admin -> Officer)
app.post('/api/claims/:id/reconsideration', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Only Admins can submit reconsideration requests' });
  }

  const { adminJustification, supplementaryEvidence } = req.body;
  if (!adminJustification?.trim()) {
    return res.status(400).json({ success: false, message: 'Admin justification is required for reconsideration' });
  }

  try {
    const request = dbManager.submitReconsideration(
      req.params.id,
      {
        adminJustification,
        supplementaryEvidence
      },
      user
    );
    res.json({ success: true, data: request });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Notifications
app.get('/api/notifications', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const notifs = dbManager.getNotifications(user.id, user.role);
  res.json({ success: true, data: notifs });
});

app.patch('/api/notifications/:id/read', (req: Request, res: Response) => {
  dbManager.markNotificationRead(req.params.id);
  res.json({ success: true });
});

// Audit Logs (Admin & Officer only)
app.get('/api/audit-logs', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== 'admin' && user.role !== 'officer')) {
    return res.status(403).json({ success: false, message: 'Audit logs restricted to Admin and Government Officers' });
  }
  const logs = dbManager.getAuditLogs();
  res.json({ success: true, data: logs });
});

// Farmer Profile Update / Bank Details Update
app.put('/api/farmer/profile', (req: Request, res: Response) => {
  const user = getAuthUser(req);
  if (!user || user.role !== 'farmer') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  const farmer = dbManager.getFarmerByUserId(user.id);
  if (!farmer) return res.status(404).json({ success: false, message: 'Farmer not found' });

  if (req.body.bankDetails) {
    farmer.bankDetails = { ...farmer.bankDetails, ...req.body.bankDetails };
  }
  if (req.body.address) {
    farmer.address = req.body.address;
  }
  if (req.body.phone) {
    farmer.phone = req.body.phone;
    user.phone = req.body.phone;
  }
  res.json({ success: true, data: farmer });
});

// ---------------- Vite Middleware or Static Production Serving ----------------
async function startServer() {
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Agri-Audit] Full-stack server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
