import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Droplets, FileText, FlaskConical, Layers, MapPinned, Pencil, Plus, Save, SprayCan, Trash2, Upload, X } from "lucide-react";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { SubpageHeader } from "../../components/SubpageHeader";
import { translateStatus } from "../../lib/statusLabels";
import {
  createFarmOperationResource,
  deleteFarmOperationResource,
  fetchBootstrap,
  fetchFarmOperationLogs,
  fetchFarmOperationsDashboard,
  fetchFarmOperationsProducts,
  fetchFarmOperationResources,
  updateFarmOperationResource,
  type FarmFeatureType,
  type FarmMapFeature,
  type FarmPlot,
  type FarmValve,
  type IrrigationLine,
  type OperationActivityType,
  type OperationDueRule,
  type OperationLog,
  type WaterAsset,
} from "../../lib/api";
import { formatNumber } from "../../lib/format";
import { hasPermission } from "../../lib/permissions";

type Mode = "builder" | "live";
type Selected = { kind: "plot" | "line" | "valve" | "water_asset"; id: string } | null;
type WaterAssetMode = "pump" | "reservoir" | null;
type LayerKey = "plots" | "irrigation" | "valves" | "pumps" | "reservoirs" | "fertilizerStatus" | "pesticideStatus" | "irrigationStatus";
type ImportGeometryType = "Polygon" | "LineString" | "Point";
type ImportPreviewRow = {
  id: string;
  selected: boolean;
  sourceName: string;
  featureName: string;
  geometryType: ImportGeometryType;
  featureType: FarmFeatureType;
  geojson: Record<string, unknown>;
};

const emptyFeature = {
  seasonId: null,
  featureType: "plot",
  featureCode: "",
  featureName: "",
  geojsonText: "",
  linkedPlotId: "",
  linkedIrrigationLineId: "",
  linkedValveId: "",
  displayOrder: 0,
  active: true,
};
const emptyPlot = { seasonId: null, plotCode: "", plotName: "", variety: "", treeCount: "", area: "", notes: "", geoFeatureId: "", active: true };
const emptyLine = { seasonId: null, lineCode: "", lineName: "", description: "", geoFeatureId: "", active: true };
const emptyValve = { seasonId: null, valveCode: "", valveName: "", irrigationLineId: "", plotId: "", estimatedTreeCount: "", notes: "", geoFeatureId: "", active: true };
const emptyWaterAsset = { assetCode: "", assetName: "", status: "", notes: "" };
const emptyRule = {
  seasonId: null,
  plotId: "",
  activityType: "irrigation" as OperationActivityType,
  activityCategory: "",
  productId: "",
  intervalDays: "5",
  dueSoonDays: "1",
  active: true,
  notes: "",
};
const emptyLog = {
  seasonId: "",
  plotId: "",
  irrigationLineId: "",
  valveId: "",
  activityType: "irrigation" as OperationActivityType,
  activityCategory: "",
  productId: "",
  productNameText: "",
  operationDate: new Date().toISOString().slice(0, 10),
  startTime: "",
  endTime: "",
  durationMinutes: "",
  qtyPerTree: "",
  totalQty: "",
  unit: "",
  treeCountCovered: "",
  performedBy: "",
  labourTeamId: "",
  remarks: "",
};
type FeatureForm = Omit<typeof emptyFeature, "seasonId"> & { seasonId: string | null };
type PlotForm = Omit<typeof emptyPlot, "seasonId"> & { seasonId: string | null };
type LineForm = Omit<typeof emptyLine, "seasonId"> & { seasonId: string | null };
type ValveForm = Omit<typeof emptyValve, "seasonId"> & { seasonId: string | null };
type RuleForm = Omit<typeof emptyRule, "seasonId"> & { seasonId: string | null };
type LocationContext = {
  plot: FarmPlot | null;
  line: IrrigationLine | null;
  valve: FarmValve | null;
};
const statusColors: Record<string, string> = {
  ok: "#16a34a",
  due_soon: "#eab308",
  overdue: "#dc2626",
  completed_today: "#2563eb",
  none: "#9ca3af",
};
const activityOptions: OperationActivityType[] = ["irrigation", "fertilizer", "pesticide", "pruning", "thinning", "pollination", "harvesting", "maintenance", "other"];
const featureTypeOptions: FarmFeatureType[] = ["farm_boundary", "plot", "irrigation_line", "valve", "landmark", "other"];

function deriveLocationContext(
  selection: Selected,
  dashboard: NonNullable<ReturnType<typeof useDashboardData>["dashboard"]> | undefined,
): LocationContext {
  if (!selection || !dashboard) return { plot: null, line: null, valve: null };
  if (selection.kind === "valve") {
    const valve = dashboard.valves.find((item) => item.id === selection.id) ?? null;
    return {
      valve,
      line: dashboard.irrigationLines.find((item) => item.id === valve?.irrigationLineId) ?? null,
      plot: dashboard.plots.find((item) => item.id === valve?.plotId) ?? null,
    };
  }
  if (selection.kind === "plot") {
    const plot = dashboard.plots.find((item) => item.id === selection.id) ?? null;
    const valve = dashboard.valves.find((item) => item.plotId === plot?.id) ?? null;
    return {
      plot,
      valve,
      line: dashboard.irrigationLines.find((item) => item.id === valve?.irrigationLineId) ?? null,
    };
  }
  if (selection.kind === "line") {
    const line = dashboard.irrigationLines.find((item) => item.id === selection.id) ?? null;
    const valve = dashboard.valves.find((item) => item.irrigationLineId === line?.id) ?? null;
    return {
      line,
      valve,
      plot: dashboard.plots.find((item) => item.id === valve?.plotId) ?? null,
    };
  }
  return { plot: null, line: null, valve: null };
}

function locationSummary(t: TFunction, context: LocationContext) {
  return [
    context.plot?.plotCode ?? t("farmMap.plotNotLinked"),
    context.line?.lineCode ?? t("farmMap.lineNotLinked"),
    context.valve?.valveCode ?? t("farmMap.valveNotLinked"),
  ].join(" | ");
}

function localChildren(element: Element | Document, name: string) {
  return Array.from(element.getElementsByTagName("*")).filter((item) => item.localName === name);
}

function firstLocalText(element: Element, name: string) {
  return localChildren(element, name)[0]?.textContent?.trim() ?? "";
}

function parseKmlCoordinates(text: string) {
  return text.trim().split(/\s+/).map((tuple) => {
    const [lng, lat] = tuple.split(",").map(Number);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }).filter(Boolean) as number[][];
}

function closeRing(ring: number[][]) {
  if (ring.length < 3) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

function defaultFeatureType(geometryType: ImportGeometryType): FarmFeatureType {
  if (geometryType === "Polygon") return "plot";
  if (geometryType === "LineString") return "irrigation_line";
  return "valve";
}

function geometryFeatureTypes(geometryType: ImportGeometryType): FarmFeatureType[] {
  if (geometryType === "Polygon") return ["plot", "farm_boundary", "other"];
  if (geometryType === "LineString") return ["irrigation_line", "other"];
  return ["valve", "landmark", "other"];
}

function parseKmlToPreviewRows(t: TFunction, kmlText: string) {
  const documentXml = new DOMParser().parseFromString(kmlText, "application/xml");
  if (documentXml.querySelector("parsererror")) throw new Error(t("farmMap.kmlParseError"));
  const placemarks = localChildren(documentXml, "Placemark");
  const rows: ImportPreviewRow[] = [];
  placemarks.forEach((placemark, placemarkIndex) => {
    const name = firstLocalText(placemark, "name") || `Placemark ${placemarkIndex + 1}`;
    localChildren(placemark, "Polygon").forEach((polygon, index) => {
      const rings = localChildren(polygon, "LinearRing")
        .map((ring) => closeRing(parseKmlCoordinates(firstLocalText(ring, "coordinates"))))
        .filter((ring) => ring.length >= 4);
      if (!rings.length) return;
      const geometryType = "Polygon" as const;
      rows.push({
        id: `${placemarkIndex}:polygon:${index}`,
        selected: true,
        sourceName: name,
        featureName: index ? `${name} polygon ${index + 1}` : name,
        geometryType,
        featureType: defaultFeatureType(geometryType),
        geojson: { type: "Polygon", coordinates: rings },
      });
    });
    localChildren(placemark, "LineString").forEach((line, index) => {
      const coordinates = parseKmlCoordinates(firstLocalText(line, "coordinates"));
      if (coordinates.length < 2) return;
      const geometryType = "LineString" as const;
      rows.push({
        id: `${placemarkIndex}:line:${index}`,
        selected: true,
        sourceName: name,
        featureName: index ? `${name} path ${index + 1}` : name,
        geometryType,
        featureType: defaultFeatureType(geometryType),
        geojson: { type: "LineString", coordinates },
      });
    });
    localChildren(placemark, "Point").forEach((point, index) => {
      const coordinates = parseKmlCoordinates(firstLocalText(point, "coordinates"))[0];
      if (!coordinates) return;
      const geometryType = "Point" as const;
      rows.push({
        id: `${placemarkIndex}:point:${index}`,
        selected: true,
        sourceName: name,
        featureName: index ? `${name} marker ${index + 1}` : name,
        geometryType,
        featureType: defaultFeatureType(geometryType),
        geojson: { type: "Point", coordinates },
      });
    });
  });
  return rows;
}

async function readKmlOrKmz(t: TFunction, file: File) {
  const extension = file.name.toLowerCase().split(".").pop();
  if (extension === "kml") return file.text();
  if (extension !== "kmz") throw new Error(t("farmMap.uploadKmlOrKmz"));
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const kmlEntry = zip.file(/(^|\/)(doc\.kml|[^/]+\.kml)$/i)[0];
  if (!kmlEntry) throw new Error(t("farmMap.kmzMissingKml"));
  return kmlEntry.async("text");
}

function normalizeFeature(feature: FarmMapFeature, statusByPlot: Map<string, Record<string, string>>, statusLayer: OperationActivityType) {
  const geojson = feature.geojson.type === "Feature"
    ? feature.geojson
    : { type: "Feature", geometry: feature.geojson, properties: {} };
  const status = feature.linkedPlotId ? statusByPlot.get(feature.linkedPlotId)?.[statusLayer] ?? "none" : "none";
  return {
    ...geojson,
    id: feature.id,
    properties: {
      ...((geojson.properties as Record<string, unknown>) ?? {}),
      featureId: feature.id,
      featureType: feature.featureType,
      linkedPlotId: feature.linkedPlotId,
      linkedIrrigationLineId: feature.linkedIrrigationLineId,
      linkedValveId: feature.linkedValveId,
      status,
      fillColor: feature.featureType === "plot" ? statusColors[status] : "#2e7d32",
    },
  };
}

function buildWaterAssetFeatures(dashboard: NonNullable<ReturnType<typeof useDashboardData>["dashboard"]>) {
  const featuresById = new Map(dashboard.features.map((feature) => [feature.id, feature]));
  return dashboard.waterAssets.flatMap((asset) => {
    const feature = featuresById.get(asset.linkedFeatureId ?? "");
    if (!feature) return [];
    const geojson = feature.geojson.type === "Feature"
      ? feature.geojson
      : { type: "Feature", geometry: feature.geojson, properties: {} };
    return [{
      ...geojson,
      id: `water:${asset.id}`,
      properties: {
        ...((geojson.properties as Record<string, unknown>) ?? {}),
        featureId: feature.id,
        featureType: asset.assetType === "pump" ? "water_pump" : "water_reservoir",
        waterAssetId: asset.id,
      },
    }];
  });
}

function firstCoordinate(features: FarmMapFeature[]) {
  for (const feature of features) {
    const raw = feature.geojson.type === "Feature" ? (feature.geojson.geometry as Record<string, unknown> | undefined) : feature.geojson;
    const coords = raw?.coordinates as unknown;
    if (Array.isArray(coords)) {
      const walk = (value: unknown): [number, number] | null => Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number"
        ? [value[0], value[1]]
        : Array.isArray(value) ? value.map(walk).find(Boolean) ?? null : null;
      const point = walk(coords);
      if (point) return point;
    }
  }
  return null;
}

function MapCanvas({
  dashboard,
  activeStatus,
  layers,
  onSelect,
  assetMode,
  onMapPoint,
}: {
  dashboard: ReturnType<typeof useDashboardData>["dashboard"];
  activeStatus: OperationActivityType;
  layers: Record<LayerKey, boolean>;
  onSelect: (selection: Selected) => void;
  assetMode?: WaterAssetMode;
  onMapPoint?: (point: { lng: number; lat: number }) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const statusByPlot = useMemo(() => new Map(dashboard?.plotStatusSummary.map((item) => [item.plotId, item.statuses]) ?? []), [dashboard?.plotStatusSummary]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const fallback = firstCoordinate(dashboard?.features ?? []);
    const center: [number, number] = dashboard?.farmMap
      ? [Number(dashboard.farmMap.centerLng), Number(dashboard.farmMap.centerLat)]
      : fallback ?? [46.6753, 24.7136];
    mapRef.current = new maplibregl.Map({
      container: containerRef.current,
      center,
      zoom: dashboard?.farmMap ? Number(dashboard.farmMap.defaultZoom) : 15,
      style: {
        version: 8,
        sources: {
          satellite: {
            type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256,
            attribution: "Tiles Esri, Maxar, Earthstar Geographics, and the GIS User Community",
          },
        },
        layers: [{ id: "satellite", type: "raster", source: "satellite" }],
      },
    });
    mapRef.current.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    mapRef.current.on("click", (event) => {
      if (assetMode && onMapPoint) onMapPoint({ lng: event.lngLat.lng, lat: event.lngLat.lat });
    });
    mapRef.current.on("click", "plot-fill", (event) => {
      if (assetMode) return;
      const id = event.features?.[0]?.properties?.linkedPlotId as string | undefined;
      if (id) onSelect({ kind: "plot", id });
    });
    mapRef.current.on("click", "irrigation-lines", (event) => {
      if (assetMode) return;
      const id = event.features?.[0]?.properties?.linkedIrrigationLineId as string | undefined;
      if (id) onSelect({ kind: "line", id });
    });
    mapRef.current.on("click", "valve-points", (event) => {
      if (assetMode) return;
      const id = event.features?.[0]?.properties?.linkedValveId as string | undefined;
      if (id) onSelect({ kind: "valve", id });
    });
    mapRef.current.on("click", "water-pumps", (event) => {
      if (assetMode) return;
      const id = event.features?.[0]?.properties?.waterAssetId as string | undefined;
      if (id) onSelect({ kind: "water_asset", id });
    });
    mapRef.current.on("click", "water-reservoirs", (event) => {
      if (assetMode) return;
      const id = event.features?.[0]?.properties?.waterAssetId as string | undefined;
      if (id) onSelect({ kind: "water_asset", id });
    });
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [assetMode, dashboard?.farmMap, dashboard?.features, onMapPoint, onSelect]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !dashboard) return;
    const render = () => {
      const allFeatures = [
        ...dashboard.features.map((feature) => normalizeFeature(feature, statusByPlot, activeStatus)),
        ...buildWaterAssetFeatures(dashboard),
      ];
      const collection = { type: "FeatureCollection", features: allFeatures };
      if (map.getSource("farm-features")) {
        (map.getSource("farm-features") as maplibregl.GeoJSONSource).setData(collection as never);
      } else {
        map.addSource("farm-features", { type: "geojson", data: collection as never });
        map.addLayer({ id: "boundary-line", type: "line", source: "farm-features", filter: ["==", ["get", "featureType"], "farm_boundary"], paint: { "line-color": "#ffffff", "line-width": 4, "line-opacity": 0.9 } });
        map.addLayer({ id: "plot-fill", type: "fill", source: "farm-features", filter: ["==", ["get", "featureType"], "plot"], paint: { "fill-color": ["get", "fillColor"], "fill-opacity": 0.34 } });
        map.addLayer({ id: "plot-line", type: "line", source: "farm-features", filter: ["==", ["get", "featureType"], "plot"], paint: { "line-color": "#f8fafc", "line-width": 2 } });
        map.addLayer({ id: "irrigation-lines", type: "line", source: "farm-features", filter: ["==", ["get", "featureType"], "irrigation_line"], paint: { "line-color": "#38bdf8", "line-width": 4 } });
        map.addLayer({ id: "valve-points", type: "circle", source: "farm-features", filter: ["==", ["get", "featureType"], "valve"], paint: { "circle-radius": 7, "circle-color": "#2563eb", "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } });
        map.addLayer({ id: "water-pumps", type: "circle", source: "farm-features", filter: ["==", ["get", "featureType"], "water_pump"], paint: { "circle-radius": 8, "circle-color": "#f97316", "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } });
        map.addLayer({ id: "water-reservoirs", type: "circle", source: "farm-features", filter: ["==", ["get", "featureType"], "water_reservoir"], paint: { "circle-radius": 9, "circle-color": "#0891b2", "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } });
      }
      map.setLayoutProperty("plot-fill", "visibility", layers.plots ? "visible" : "none");
      map.setLayoutProperty("plot-line", "visibility", layers.plots ? "visible" : "none");
      map.setLayoutProperty("irrigation-lines", "visibility", layers.irrigation ? "visible" : "none");
      map.setLayoutProperty("valve-points", "visibility", layers.valves ? "visible" : "none");
      map.setLayoutProperty("water-pumps", "visibility", layers.pumps ? "visible" : "none");
      map.setLayoutProperty("water-reservoirs", "visibility", layers.reservoirs ? "visible" : "none");
    };
    if (map.loaded()) render();
    else map.once("load", render);
  }, [activeStatus, dashboard, layers.irrigation, layers.plots, layers.pumps, layers.reservoirs, layers.valves, statusByPlot]);

  return <div className="farm-map-canvas" ref={containerRef} />;
}

function useDashboardData(workspaceId: string, farmId: string, seasonId?: string | null) {
  const { token } = useAuth();
  const query = useQuery({
    queryKey: ["farm-operations-dashboard", workspaceId, farmId, seasonId],
    queryFn: () => fetchFarmOperationsDashboard(token!, workspaceId, farmId, seasonId),
    enabled: Boolean(token && workspaceId && farmId),
  });
  return { ...query, dashboard: query.data };
}

function StatusBadges({ statuses }: { statuses?: Record<string, string> }) {
  const { t } = useTranslation();
  return <div className="farm-status-badges">
    {["irrigation", "fertilizer", "pesticide"].map((activity) => <span key={activity} style={{ borderColor: statusColors[statuses?.[activity] ?? "none"] }}>{translateStatus(t, activity)}: {translateStatus(t, statuses?.[activity] ?? "none")}</span>)}
  </div>;
}

function OperationLogForm({
  dashboard,
  products,
  initial,
  onSubmit,
  pending,
  onChangeLocation,
}: {
  dashboard: NonNullable<ReturnType<typeof useDashboardData>["dashboard"]>;
  products: Awaited<ReturnType<typeof fetchFarmOperationsProducts>>["records"];
  initial: typeof emptyLog;
  onSubmit: (input: typeof emptyLog) => void;
  pending: boolean;
  onChangeLocation: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial), [initial]);
  const selectedValve = dashboard.valves.find((valve) => valve.id === form.valveId) ?? null;
  const selectedPlot = dashboard.plots.find((plot) => plot.id === form.plotId) ?? null;
  const selectedLine = dashboard.irrigationLines.find((line) => line.id === form.irrigationLineId) ?? null;
  const selectedProduct = products.find((product) => product.id === form.productId) ?? null;
  const formTitle = form.activityType === "irrigation"
    ? t("farmMap.logIrrigationTitle")
    : form.activityType === "fertilizer"
      ? t("farmMap.logFertilizerTitle")
      : t("farmMap.logSprayTitle");
  useEffect(() => {
    const trees = Number(selectedPlot?.treeCount || form.treeCountCovered || 0);
    const qty = Number(form.totalQty || 0);
    if (form.activityType !== "fertilizer") return;
    if (trees > 0 && qty > 0) setForm((current) => ({ ...current, qtyPerTree: String(Number((qty / trees).toFixed(4))) }));
  }, [form.activityType, form.totalQty, form.treeCountCovered, selectedPlot?.treeCount]);
  useEffect(() => {
    if (!selectedProduct?.unit) return;
    setForm((current) => current.unit === selectedProduct.unit ? current : { ...current, unit: selectedProduct.unit ?? "" });
  }, [selectedProduct?.unit]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(form);
  };
  const activityProducts = products.filter((product) => {
    if (form.activityType === "fertilizer") return product.productType === "fertilizer" || product.productType === "other";
    if (form.activityType === "pesticide") return product.productType === "pesticide" || product.productType === "other";
    return false;
  });
  return <form className="farm-operation-form farm-operation-form--simple" onSubmit={submit}>
    <div className="farm-operation-form__header">
      <h3>{formTitle}</h3>
      <p>{t("farmMap.operationFormHint")}</p>
    </div>
    <div className="farm-operation-form__location">
      <div className="farm-operation-form__readonly">
        <span>{t("farmMap.locationLabel")}</span>
        <strong className="bidi-isolate">{locationSummary(t, { plot: selectedPlot, line: selectedLine, valve: selectedValve })}</strong>
      </div>
      <button className="secondary-button" type="button" onClick={onChangeLocation}>{t("farmMap.changeLocationAction")}</button>
    </div>
    <input type="date" value={form.operationDate} onChange={(event) => setForm({ ...form, operationDate: event.target.value })} />
    {form.activityType === "irrigation" && <>
      <div className="farm-duration-presets">
        {[1, 2, 3, 4, 5].map((hours) => <button key={hours} className={form.durationMinutes === String(hours * 60) ? "is-active" : ""} type="button" onClick={() => setForm({ ...form, durationMinutes: String(hours * 60) })}><span className="bidi-isolate">{hours}</span> {t("farmMap.hoursUnit", { count: hours })}</button>)}
        <button className={!["60", "120", "180", "240", "300"].includes(form.durationMinutes) && form.durationMinutes ? "is-active" : ""} type="button" onClick={() => setForm({ ...form, durationMinutes: "" })}>{t("farmMap.customDuration")}</button>
      </div>
      <input inputMode="numeric" placeholder={t("farmMap.durationMinutesPlaceholder")} value={form.durationMinutes} onChange={(event) => setForm({ ...form, durationMinutes: event.target.value })} />
    </>}
    {form.activityType === "fertilizer" && <>
      <select value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })}>
        <option value="">{t("farmMap.productPlaceholderOption")}</option>
        {activityProducts.map((product) => <option key={product.id} value={product.id}>{product.productName}</option>)}
      </select>
      <input inputMode="decimal" placeholder={t("farmMap.quantityPlaceholder")} value={form.totalQty} onChange={(event) => setForm({ ...form, totalQty: event.target.value })} />
      <input placeholder={t("farmMap.unitPlaceholder")} value={form.unit || "kg"} onChange={(event) => setForm({ ...form, unit: event.target.value })} />
    </>}
    {form.activityType === "pesticide" && <>
      <select value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })}>
        <option value="">{t("farmMap.productPlaceholderOption")}</option>
        {activityProducts.map((product) => <option key={product.id} value={product.id}>{product.productName}</option>)}
      </select>
      <input inputMode="decimal" placeholder={selectedProduct?.unit ? t("farmMap.quantityDoseWithUnitPlaceholder", { unit: selectedProduct.unit }) : t("farmMap.quantityDosePlaceholder")} value={form.totalQty} onChange={(event) => setForm({ ...form, totalQty: event.target.value })} />
    </>}
    <textarea placeholder={t("farmMap.remarksOptionalPlaceholder")} value={form.remarks} onChange={(event) => setForm({ ...form, remarks: event.target.value })} />
    <button type="submit" disabled={pending || !form.plotId || !form.valveId || !form.irrigationLineId || (form.activityType !== "irrigation" && !form.productId)}>
      <Save size={16} />
      {pending ? t("farmMap.savingAction") : t("common.save")}
    </button>
  </form>;
}

function SideDrawer({
  selected,
  dashboard,
  logs,
  mode,
  builderHref,
  onClose,
  onQuickLog,
  onEditPlot,
  onEditLine,
  onEditValve,
  onEditWaterAsset,
  onDeactivatePlot,
  onDeactivateLine,
  onDeactivateValve,
  onDeleteWaterAsset,
  onViewHistory,
}: {
  selected: Selected;
  dashboard: NonNullable<ReturnType<typeof useDashboardData>["dashboard"]>;
  logs: OperationLog[];
  mode: Mode;
  builderHref: string;
  onClose: () => void;
  onQuickLog: (activity: OperationActivityType, selection: Selected) => void;
  onEditPlot: (plot: FarmPlot) => void;
  onEditLine: (line: IrrigationLine) => void;
  onEditValve: (valve: FarmValve) => void;
  onEditWaterAsset: (asset: WaterAsset) => void;
  onDeactivatePlot: (plot: FarmPlot) => void;
  onDeactivateLine: (line: IrrigationLine) => void;
  onDeactivateValve: (valve: FarmValve) => void;
  onDeleteWaterAsset: (asset: WaterAsset) => void;
  onViewHistory: () => void;
}) {
  const { t } = useTranslation();
  if (!selected) return null;
  const plot = selected.kind === "plot" ? dashboard.plots.find((item) => item.id === selected.id) : null;
  const irrigationLine = selected.kind === "line" ? dashboard.irrigationLines.find((item) => item.id === selected.id) : null;
  const valve = selected.kind === "valve" ? dashboard.valves.find((item) => item.id === selected.id) : null;
  const waterAsset = selected.kind === "water_asset" ? dashboard.waterAssets.find((item) => item.id === selected.id) : null;
  const linkedPlot = plot ?? dashboard.plots.find((item) => item.id === valve?.plotId);
  const linkedValves = linkedPlot ? dashboard.valves.filter((item) => item.plotId === linkedPlot.id) : [];
  const line = irrigationLine ?? dashboard.irrigationLines.find((item) => item.id === valve?.irrigationLineId);
  const statuses = linkedPlot ? dashboard.plotStatusSummary.find((item) => item.plotId === linkedPlot.id)?.statuses : undefined;
  const scopedLogs = logs.filter((item) => selected.kind === "plot" ? item.plotId === selected.id : selected.kind === "line" ? item.irrigationLineId === selected.id : item.valveId === selected.id).slice(0, 12);
  const managementHint = mode === "live" ? <Link className="secondary-button farm-drawer-link" to={builderHref}>{t("farmMap.openBuilderToEdit")}</Link> : null;
  const lastByActivity = (activity: OperationActivityType) => scopedLogs.find((log) => log.activityType === activity) ?? null;
  return <aside className="farm-map-drawer">
    <button className="farm-map-drawer__close" type="button" onClick={onClose}><X size={16} /></button>
    {waterAsset && <>
      <h2>{waterAsset.assetType === "pump" ? t("farmMap.pumpBoreholeLabel") : t("farmMap.reservoirLabel")}</h2>
      <dl className="farm-map-facts">
        <div><dt>{t("farmMap.assetCodeLabel")}</dt><dd className="bidi-isolate">{waterAsset.assetCode}</dd></div>
        <div><dt>{t("farmMap.assetNameLabel")}</dt><dd>{waterAsset.assetName}</dd></div>
        <div><dt>{t("common.status")}</dt><dd>{waterAsset.status || "-"}</dd></div>
        <div><dt>{t("farmMap.notesLabel")}</dt><dd>{waterAsset.notes || "-"}</dd></div>
      </dl>
      <div className="farm-drawer-actions">
        <button type="button" onClick={() => onEditWaterAsset(waterAsset)}><Pencil size={15} />{t("farmMap.editAssetAction")}</button>
        <button className="danger-button" type="button" onClick={() => onDeleteWaterAsset(waterAsset)}><Trash2 size={15} />{t("farmMap.deleteAssetAction")}</button>
      </div>
      {managementHint}
    </>}
    {plot && <><h2><span className="bidi-isolate">{plot.plotCode}</span> {plot.plotName ?? ""}</h2><p>{plot.variety ?? t("farmMap.varietyNotRecorded")} | <span className="bidi-isolate">{plot.treeCount ?? 0}</span> {t("farmMap.treesUnit", { count: plot.treeCount ?? 0 })}</p><StatusBadges statuses={statuses} /></>}
    {irrigationLine && <><h2><span className="bidi-isolate">{irrigationLine.lineCode}</span> {irrigationLine.lineName ?? ""}</h2><p>{irrigationLine.description || t("farmMap.irrigationLineLabel")}</p></>}
    {valve && <><h2><span className="bidi-isolate">{valve.valveCode}</span> {valve.valveName ?? ""}</h2><p>{line?.lineName ?? line?.lineCode ?? t("farmMap.noLine")} | {linkedPlot?.plotName ?? linkedPlot?.plotCode ?? t("farmMap.noPlot")}</p><StatusBadges statuses={statuses} /></>}
    {!waterAsset && <div className="farm-quick-actions">
      <button type="button" onClick={() => onQuickLog("irrigation", selected)}><Droplets size={17} />{t("farmMap.logIrrigationAction")}</button>
      <button type="button" onClick={() => onQuickLog("fertilizer", selected)}><FlaskConical size={17} />{t("farmMap.logFertilizerAction")}</button>
      <button type="button" onClick={() => onQuickLog("pesticide", selected)}><SprayCan size={17} />{t("farmMap.logSprayAction")}</button>
      <button type="button" onClick={onViewHistory}><FileText size={17} />{t("farmMap.viewHistoryAction")}</button>
    </div>}
    {plot && <><div className="farm-drawer-actions"><button type="button" onClick={() => onEditPlot(plot)}><Pencil size={15} />{t("farmMap.editPlotAction")}</button><button className="danger-button" type="button" onClick={() => onDeactivatePlot(plot)}><Trash2 size={15} />{t("farmMap.deleteDeactivateAction")}</button></div>{managementHint}</>}
    {irrigationLine && <><div className="farm-drawer-actions"><button type="button" onClick={() => onEditLine(irrigationLine)}><Pencil size={15} />{t("farmMap.editLineAction")}</button><button className="danger-button" type="button" onClick={() => onDeactivateLine(irrigationLine)}><Trash2 size={15} />{t("farmMap.deleteDeactivateAction")}</button></div>{managementHint}</>}
    {valve && <><div className="farm-drawer-actions"><button type="button" onClick={() => onEditValve(valve)}><Pencil size={15} />{t("farmMap.editValve")}</button><button className="danger-button" type="button" onClick={() => onDeactivateValve(valve)}><Trash2 size={15} />{t("farmMap.deleteDeactivateAction")}</button></div>{managementHint}</>}
    {!waterAsset && <dl className="farm-map-facts">
      <div><dt>{t("farmMap.lastIrrigation")}</dt><dd className="bidi-isolate">{lastByActivity("irrigation")?.operationDate ?? "-"}</dd></div>
      <div><dt>{t("farmMap.lastFertilizer")}</dt><dd className="bidi-isolate">{lastByActivity("fertilizer")?.operationDate ?? "-"}</dd></div>
      <div><dt>{t("farmMap.lastSpray")}</dt><dd className="bidi-isolate">{lastByActivity("pesticide")?.operationDate ?? "-"}</dd></div>
      <div><dt>{t("farmMap.linkedValves")}</dt><dd className="bidi-isolate">{linkedValves.map((item) => item.valveCode).join(", ") || "-"}</dd></div>
      <div><dt>{t("farmMap.linkedLines")}</dt><dd className="bidi-isolate">{[...new Set(linkedValves.map((item) => dashboard.irrigationLines.find((lineItem) => lineItem.id === item.irrigationLineId)?.lineCode).filter(Boolean))].join(", ") || line?.lineCode || "-"}</dd></div>
      <div><dt>{t("farmMap.pendingWork")}</dt><dd>{dashboard.dueWorkList.filter((item) => item.plotId === linkedPlot?.id).map((item) => t("farmMap.activityStatusLabel", { activity: translateStatus(t, item.activityType), status: translateStatus(t, item.status) })).join(", ") || "-"}</dd></div>
    </dl>}
    {!waterAsset && <><h3>{t("farmMap.operationHistory")}</h3>
      <div className="farm-log-list">{scopedLogs.map((log) => <article key={log.id}><strong>{translateStatus(t, log.activityType)}</strong><span><span className="bidi-isolate">{log.operationDate}</span>{log.totalQty ? <> | <span className="bidi-isolate">{`${log.totalQty} ${log.unit ?? ""}`}</span></> : ""}</span><small>{log.performedBy || log.remarks || "-"}</small></article>)}</div></>}
  </aside>;
}

export function FarmOperationsMap({ mode }: { mode: Mode }) {
  const { t } = useTranslation();
  const { user, token } = useAuth();
  const params = useParams();
  const queryClient = useQueryClient();
  const workspaceId = params.workspaceId ?? user?.workspaceId ?? "";
  const bootstrap = useQuery({ queryKey: ["bootstrap", token], queryFn: () => fetchBootstrap(token!), enabled: Boolean(token) });
  const farmId = params.farmId ?? bootstrap.data?.activeFarmId ?? "";
  const activeSeasonId = bootstrap.data?.activeSeasonId ?? null;
  const canManage = Boolean(user && hasPermission(user, "MANAGE_RECORDS", workspaceId));
  const dashboardQuery = useDashboardData(workspaceId, farmId, activeSeasonId);
  const products = useQuery({ queryKey: ["farm-products", workspaceId, farmId], queryFn: () => fetchFarmOperationsProducts(token!, workspaceId, farmId), enabled: Boolean(token && workspaceId && farmId) });
  const logsQuery = useQuery({ queryKey: ["farm-operation-logs", workspaceId, farmId, activeSeasonId], queryFn: () => fetchFarmOperationLogs(token!, workspaceId, { farmId, seasonId: activeSeasonId }), enabled: Boolean(token && workspaceId && farmId) });
  const plotsQuery = useQuery({ queryKey: ["farm-operation-records", workspaceId, farmId, "plots"], queryFn: () => fetchFarmOperationResources<FarmPlot>(token!, workspaceId, farmId, "plots"), enabled: Boolean(token && workspaceId && farmId && canManage) });
  const linesQuery = useQuery({ queryKey: ["farm-operation-records", workspaceId, farmId, "irrigation-lines"], queryFn: () => fetchFarmOperationResources<IrrigationLine>(token!, workspaceId, farmId, "irrigation-lines"), enabled: Boolean(token && workspaceId && farmId && canManage) });
  const valvesQuery = useQuery({ queryKey: ["farm-operation-records", workspaceId, farmId, "valves"], queryFn: () => fetchFarmOperationResources<FarmValve>(token!, workspaceId, farmId, "valves"), enabled: Boolean(token && workspaceId && farmId && canManage) });
  const featuresQuery = useQuery({ queryKey: ["farm-operation-records", workspaceId, farmId, "features"], queryFn: () => fetchFarmOperationResources<FarmMapFeature>(token!, workspaceId, farmId, "features"), enabled: Boolean(token && workspaceId && farmId && canManage) });
  const waterAssetsQuery = useQuery({ queryKey: ["farm-operation-records", workspaceId, farmId, "water-assets"], queryFn: () => fetchFarmOperationResources<WaterAsset>(token!, workspaceId, farmId, "water-assets"), enabled: Boolean(token && workspaceId && farmId && canManage) });
  const rulesQuery = useQuery({ queryKey: ["farm-operation-records", workspaceId, farmId, "operation-due-rules"], queryFn: () => fetchFarmOperationResources<OperationDueRule>(token!, workspaceId, farmId, "operation-due-rules"), enabled: Boolean(token && workspaceId && farmId && canManage) });
  const [selected, setSelected] = useState<Selected>(null);
  const [activeStatus, setActiveStatus] = useState<OperationActivityType>("irrigation");
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ plots: true, irrigation: true, valves: true, pumps: true, reservoirs: true, fertilizerStatus: true, pesticideStatus: true, irrigationStatus: true });
  const [featureForm, setFeatureForm] = useState<FeatureForm>(emptyFeature);
  const [plotForm, setPlotForm] = useState<PlotForm>(emptyPlot);
  const [lineForm, setLineForm] = useState<LineForm>(emptyLine);
  const [valveForm, setValveForm] = useState<ValveForm>(emptyValve);
  const [assetMode, setAssetMode] = useState<WaterAssetMode>(null);
  const [assetPoint, setAssetPoint] = useState<{ lng: number; lat: number } | null>(null);
  const [assetForm, setAssetForm] = useState(emptyWaterAsset);
  const [mapForm, setMapForm] = useState({ mapName: t("farmMap.defaultMapName"), centerLat: "24.7136", centerLng: "46.6753", defaultZoom: "16", notes: "" });
  const [logForm, setLogForm] = useState(emptyLog);
  const [ruleForm, setRuleForm] = useState<RuleForm>(emptyRule);
  const [editingIds, setEditingIds] = useState<{ feature: string | null; plot: string | null; line: string | null; valve: string | null; waterAsset: string | null; log: string | null; rule: string | null }>({ feature: null, plot: null, line: null, valve: null, waterAsset: null, log: null, rule: null });
  const [showInactive, setShowInactive] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [importRows, setImportRows] = useState<ImportPreviewRow[]>([]);
  const [importFilename, setImportFilename] = useState("");
  const [importError, setImportError] = useState("");
  const logsSectionRef = useRef<HTMLElement | null>(null);
  const dashboard = dashboardQuery.dashboard;
  useEffect(() => {
    if (activeSeasonId) {
      setLogForm((current) => ({ ...current, seasonId: activeSeasonId }));
      setFeatureForm((current) => ({ ...current, seasonId: activeSeasonId }));
      setPlotForm((current) => ({ ...current, seasonId: activeSeasonId }));
      setLineForm((current) => ({ ...current, seasonId: activeSeasonId }));
      setValveForm((current) => ({ ...current, seasonId: activeSeasonId }));
      setRuleForm((current) => ({ ...current, seasonId: activeSeasonId }));
    }
  }, [activeSeasonId]);
  useEffect(() => {
    if (dashboard?.farmMap) setMapForm({ mapName: dashboard.farmMap.mapName, centerLat: dashboard.farmMap.centerLat, centerLng: dashboard.farmMap.centerLng, defaultZoom: dashboard.farmMap.defaultZoom, notes: dashboard.farmMap.notes ?? "" });
  }, [dashboard?.farmMap]);
  const resetFeatureForm = () => {
    setFeatureForm({ ...emptyFeature, seasonId: activeSeasonId });
    setEditingIds((current) => ({ ...current, feature: null }));
  };
  const resetPlotForm = () => {
    setPlotForm({ ...emptyPlot, seasonId: activeSeasonId });
    setEditingIds((current) => ({ ...current, plot: null }));
  };
  const resetLineForm = () => {
    setLineForm({ ...emptyLine, seasonId: activeSeasonId });
    setEditingIds((current) => ({ ...current, line: null }));
  };
  const resetValveForm = () => {
    setValveForm({ ...emptyValve, seasonId: activeSeasonId });
    setEditingIds((current) => ({ ...current, valve: null }));
  };
  const resetWaterAssetForm = () => {
    setAssetMode(null);
    setAssetPoint(null);
    setAssetForm(emptyWaterAsset);
    setEditingIds((current) => ({ ...current, waterAsset: null }));
  };
  const resetLogForm = () => {
    setLogForm({ ...emptyLog, seasonId: activeSeasonId ?? "" });
    setEditingIds((current) => ({ ...current, log: null }));
  };
  const resetRuleForm = () => {
    setRuleForm({ ...emptyRule, seasonId: activeSeasonId });
    setEditingIds((current) => ({ ...current, rule: null }));
  };
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["farm-operations-dashboard", workspaceId, farmId] }),
      queryClient.invalidateQueries({ queryKey: ["farm-operation-logs", workspaceId, farmId] }),
      queryClient.invalidateQueries({ queryKey: ["farm-operation-records", workspaceId, farmId] }),
    ]);
  };
  const saveResource = useMutation({
    mutationFn: ({ resource, input, id }: { resource: string; input: unknown; id?: string }) => id
      ? updateFarmOperationResource(token!, workspaceId, farmId, resource, id, input)
      : createFarmOperationResource(token!, workspaceId, farmId, resource, input),
    onSuccess: refresh,
  });
  const deleteResource = useMutation({
    mutationFn: ({ resource, id }: { resource: string; id: string }) => deleteFarmOperationResource(token!, workspaceId, farmId, resource, id),
    onSuccess: refresh,
  });
  const deactivateResource = async (resource: string, id: string, input: Record<string, unknown>) => {
    await updateFarmOperationResource(token!, workspaceId, farmId, resource, id, { ...input, active: false });
    await refresh();
  };
  const quickLog = (activity: OperationActivityType, selection: Selected) => {
    const context = deriveLocationContext(selection, dashboard);
    if (!context.plot || !context.line || !context.valve) {
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: t("farmMap.linkLocationBeforeLogging") }));
      return;
    }
    setLogForm({
      ...emptyLog,
      seasonId: activeSeasonId ?? "",
      activityType: activity,
      plotId: context.plot.id,
      valveId: context.valve.id,
      irrigationLineId: context.line.id,
      treeCountCovered: String(context.plot.treeCount ?? context.valve.estimatedTreeCount ?? ""),
      unit: activity === "fertilizer" ? "kg" : "",
    });
    setEditingIds((current) => ({ ...current, log: null }));
    setShowLog(true);
  };
  const submitLog = (input: typeof emptyLog) => saveResource.mutate({
    resource: "operation-logs",
    id: editingIds.log ?? undefined,
    input: {
      ...input,
      durationMinutes: input.activityType === "irrigation" ? input.durationMinutes || null : null,
      qtyPerTree: input.activityType === "fertilizer" ? input.qtyPerTree || null : null,
      totalQty: (input.activityType === "fertilizer" || input.activityType === "pesticide") ? input.totalQty || null : null,
      unit: input.activityType === "fertilizer" || input.activityType === "pesticide" ? input.unit || null : null,
      treeCountCovered: input.activityType === "fertilizer" ? input.treeCountCovered || null : null,
      activityCategory: input.activityType === "pesticide" ? input.activityCategory || null : null,
      productId: input.activityType === "fertilizer" || input.activityType === "pesticide" ? input.productId || null : null,
      productNameText: null,
      startTime: null,
      endTime: null,
    },
  }, { onSuccess: () => {
    const activityWord = input.activityType === "irrigation" ? t("farmMap.irrigationWord") : input.activityType === "fertilizer" ? t("farmMap.fertilizerWord") : t("farmMap.sprayWord");
    window.dispatchEvent(new CustomEvent("muzare-toast", { detail: t("farmMap.operationLoggedToast", { activity: activityWord }) }));
    resetLogForm();
    setShowLog(false);
  } });
  const saveFeature = (event: FormEvent) => {
    event.preventDefault();
    let geojson: Record<string, unknown>;
    try {
      geojson = JSON.parse(featureForm.geojsonText) as Record<string, unknown>;
    } catch {
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: t("farmMap.invalidGeoJson") }));
      return;
    }
    saveResource.mutate({ resource: "features", id: editingIds.feature ?? undefined, input: { ...featureForm, geojson, styleJson: null, geojsonText: undefined } }, { onSuccess: resetFeatureForm });
  };
  const saveMap = (event: FormEvent) => {
    event.preventDefault();
    const input = { ...mapForm, seasonId: activeSeasonId, baseMapProvider: "maplibre_satellite" };
    saveResource.mutate({ resource: "maps", id: dashboard?.farmMap?.id, input });
  };
  const beginWaterAsset = (nextMode: Exclude<WaterAssetMode, null>) => {
    setAssetMode(nextMode);
    setAssetPoint(null);
    setAssetForm(emptyWaterAsset);
    setEditingIds((current) => ({ ...current, waterAsset: null }));
    const assetLabel = nextMode === "pump" ? t("farmMap.pumpBoreholeLower") : t("farmMap.reservoirLower");
    window.dispatchEvent(new CustomEvent("muzare-toast", { detail: t("farmMap.clickMapLocationForAsset", { assetLabel }) }));
  };
  const saveWaterAsset = async (event: FormEvent) => {
    event.preventDefault();
    if (!assetMode) return;
    try {
      let linkedFeatureId = waterAssetsQuery.data?.records.find((item) => item.id === editingIds.waterAsset)?.linkedFeatureId ?? null;
      if (!linkedFeatureId) {
        if (!assetPoint) return;
        const featureResult = await saveResource.mutateAsync({
          resource: "features",
          input: {
            seasonId: activeSeasonId,
            featureType: "landmark",
            featureCode: assetForm.assetCode,
            featureName: assetForm.assetName,
            geojson: { type: "Point", coordinates: [assetPoint.lng, assetPoint.lat] },
            linkedPlotId: "",
            linkedIrrigationLineId: "",
            linkedValveId: "",
            styleJson: { waterAssetType: assetMode },
            displayOrder: 0,
            active: true,
          },
        }) as { record: FarmMapFeature };
        linkedFeatureId = featureResult.record.id;
      }
      await saveResource.mutateAsync({
        resource: "water-assets",
        id: editingIds.waterAsset ?? undefined,
        input: {
          seasonId: activeSeasonId,
          assetType: assetMode,
          assetCode: assetForm.assetCode,
          assetName: assetForm.assetName,
          linkedFeatureId,
          status: assetForm.status,
          notes: assetForm.notes,
          active: true,
        },
      });
      resetWaterAssetForm();
      await refresh();
    } catch (error) {
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: error instanceof Error ? error.message : t("farmMap.unableToSaveWaterAsset") }));
    }
  };
  const saveRule = (event: FormEvent) => {
    event.preventDefault();
    saveResource.mutate({
      resource: "operation-due-rules",
      id: editingIds.rule ?? undefined,
      input: {
        ...ruleForm,
        intervalDays: Number(ruleForm.intervalDays),
        dueSoonDays: Number(ruleForm.dueSoonDays),
      },
    }, { onSuccess: resetRuleForm });
  };
  const uploadKml = async (file: File | null) => {
    if (!file) return;
    setImportError("");
    setImportFilename(file.name);
    try {
      const rows = parseKmlToPreviewRows(t, await readKmlOrKmz(t, file));
      setImportRows(rows);
      if (!rows.length) setImportError(t("farmMap.noPlacemarksFound"));
    } catch (error) {
      setImportRows([]);
      setImportError(error instanceof Error ? error.message : t("farmMap.unableToImportLayout"));
    }
  };
  const updateImportRow = (id: string, patch: Partial<ImportPreviewRow>) => {
    setImportRows((rows) => rows.map((row) => row.id === id ? { ...row, ...patch } : row));
  };
  const saveImportRows = async () => {
    const selectedRows = importRows.filter((row) => row.selected);
    if (!selectedRows.length) {
      setImportError(t("farmMap.selectFeatureToImport"));
      return;
    }
    setImportError("");
    try {
      for (const [index, row] of selectedRows.entries()) {
        await saveResource.mutateAsync({
          resource: "features",
          input: {
            seasonId: activeSeasonId,
            featureType: row.featureType,
            featureCode: row.featureName.trim().slice(0, 80) || `${row.geometryType}-${index + 1}`,
            featureName: row.featureName.trim() || row.sourceName,
            geojson: row.geojson,
            linkedPlotId: "",
            linkedIrrigationLineId: "",
            linkedValveId: "",
            styleJson: null,
            displayOrder: index,
            active: true,
          },
        });
      }
      setImportRows([]);
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: t("farmMap.featuresImportedToast", { count: selectedRows.length }) }));
      await refresh();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : t("farmMap.unableToSaveImportedFeatures"));
    }
  };
  const startEditFeature = (feature: FarmMapFeature) => {
    setFeatureForm({
      seasonId: feature.seasonId,
      featureType: feature.featureType,
      featureCode: feature.featureCode ?? "",
      featureName: feature.featureName,
      geojsonText: JSON.stringify(feature.geojson, null, 2),
      linkedPlotId: feature.linkedPlotId ?? "",
      linkedIrrigationLineId: feature.linkedIrrigationLineId ?? "",
      linkedValveId: feature.linkedValveId ?? "",
      displayOrder: feature.displayOrder,
      active: feature.active,
    });
    setEditingIds((current) => ({ ...current, feature: feature.id }));
  };
  const startEditPlot = (plot: FarmPlot) => {
    setPlotForm({
      seasonId: plot.seasonId,
      plotCode: plot.plotCode,
      plotName: plot.plotName ?? "",
      variety: plot.variety ?? "",
      treeCount: plot.treeCount === null ? "" : String(plot.treeCount),
      area: plot.area ?? "",
      notes: plot.notes ?? "",
      geoFeatureId: plot.geoFeatureId ?? "",
      active: plot.active,
    });
    setEditingIds((current) => ({ ...current, plot: plot.id }));
  };
  const startEditLine = (line: IrrigationLine) => {
    setLineForm({
      seasonId: line.seasonId,
      lineCode: line.lineCode,
      lineName: line.lineName ?? "",
      description: line.description ?? "",
      geoFeatureId: line.geoFeatureId ?? "",
      active: line.active,
    });
    setEditingIds((current) => ({ ...current, line: line.id }));
  };
  const startEditValve = (valve: FarmValve) => {
    setValveForm({
      seasonId: valve.seasonId,
      valveCode: valve.valveCode,
      valveName: valve.valveName ?? "",
      irrigationLineId: valve.irrigationLineId ?? "",
      plotId: valve.plotId ?? "",
      estimatedTreeCount: valve.estimatedTreeCount === null ? "" : String(valve.estimatedTreeCount),
      notes: valve.notes ?? "",
      geoFeatureId: valve.geoFeatureId ?? "",
      active: valve.active,
    });
    setEditingIds((current) => ({ ...current, valve: valve.id }));
  };
  const startEditWaterAsset = (asset: WaterAsset) => {
    setAssetMode(asset.assetType);
    setAssetForm({ assetCode: asset.assetCode, assetName: asset.assetName, status: asset.status ?? "", notes: asset.notes ?? "" });
    setEditingIds((current) => ({ ...current, waterAsset: asset.id }));
  };
  const startEditRule = (rule: OperationDueRule) => {
    setRuleForm({
      seasonId: rule.seasonId,
      plotId: rule.plotId ?? "",
      activityType: rule.activityType,
      activityCategory: rule.activityCategory ?? "",
      productId: rule.productId ?? "",
      intervalDays: String(rule.intervalDays),
      dueSoonDays: String(rule.dueSoonDays),
      active: rule.active,
      notes: rule.notes ?? "",
    });
    setEditingIds((current) => ({ ...current, rule: rule.id }));
  };
  const startEditLog = (log: OperationLog) => {
    setLogForm({
      seasonId: log.seasonId,
      plotId: log.plotId ?? "",
      irrigationLineId: log.irrigationLineId ?? "",
      valveId: log.valveId ?? "",
      activityType: log.activityType,
      activityCategory: log.activityCategory ?? "",
      productId: log.productId ?? "",
      productNameText: log.productNameText ?? "",
      operationDate: log.operationDate,
      startTime: log.startTime ?? "",
      endTime: log.endTime ?? "",
      durationMinutes: log.durationMinutes === null ? "" : String(log.durationMinutes),
      qtyPerTree: log.qtyPerTree ?? "",
      totalQty: log.totalQty ?? "",
      unit: log.unit ?? "",
      treeCountCovered: log.treeCountCovered === null ? "" : String(log.treeCountCovered),
      performedBy: log.performedBy ?? "",
      labourTeamId: "",
      remarks: log.remarks ?? "",
    });
    setEditingIds((current) => ({ ...current, log: log.id }));
    setShowLog(true);
  };
  const requestDelete = async (resource: string, id: string, label: string, inputForDeactivate?: Record<string, unknown>) => {
    if (!window.confirm(t("farmMap.confirmDeleteLabel", { label }))) return;
    try {
      await deleteResource.mutateAsync({ resource, id });
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: t("farmMap.labelDeletedToast", { label }) }));
    } catch (error) {
      if (error instanceof Error && "status" in error && (error as { status?: number }).status === 409 && inputForDeactivate) {
        if (window.confirm(t("farmMap.confirmDeactivateLabel", { label }))) {
          await deactivateResource(resource, id, inputForDeactivate);
          window.dispatchEvent(new CustomEvent("muzare-toast", { detail: t("farmMap.labelDeactivatedToast", { label }) }));
        }
        return;
      }
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: error instanceof Error ? error.message : t("farmMap.unableToDeleteLabel", { label }) }));
    }
  };
  const logs = logsQuery.data?.records ?? [];
  const managedPlots = (plotsQuery.data?.records ?? []).filter((item) => showInactive || item.active);
  const managedLines = (linesQuery.data?.records ?? []).filter((item) => showInactive || item.active);
  const managedValves = (valvesQuery.data?.records ?? []).filter((item) => showInactive || item.active);
  const managedFeatures = (featuresQuery.data?.records ?? []).filter((item) => showInactive || item.active);
  const managedWaterAssets = (waterAssetsQuery.data?.records ?? []).filter((item) => showInactive || item.active);
  const managedRules = (rulesQuery.data?.records ?? []).filter((item) => showInactive || item.active);
  const selectedStatus = selected?.kind === "plot" ? dashboard?.plotStatusSummary.find((item) => item.plotId === selected.id)?.statuses : undefined;
  const totalTrees = dashboard?.plots.reduce((sum, plot) => sum + (plot.treeCount ?? 0), 0) ?? 0;
  const viewSelectedHistory = () => logsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const layerLabels: Record<"plots" | "irrigation" | "valves" | "pumps" | "reservoirs", string> = {
    plots: t("farmMap.layerPlots"),
    irrigation: t("farmMap.layerIrrigation"),
    valves: t("farmMap.layerValves"),
    pumps: t("farmMap.layerPumps"),
    reservoirs: t("farmMap.layerReservoirs"),
  };
  return <div className="dashboard-page farm-map-page">
    <SubpageHeader title={mode === "builder" ? t("farmMap.builderPageTitle") : t("farmMap.livePageTitle")} />
    <main className="subpage farm-map-shell">
      {!farmId && <p className="error">{t("farmMap.noFarmSelected")}</p>}
      {dashboardQuery.isLoading && <p className="context-message">{t("farmMap.loading")}</p>}
      {dashboardQuery.isError && <p className="error">{dashboardQuery.error.message}</p>}
      {dashboard && <>
        <section className="farm-map-topbar">
          <article><span>{t("farmMap.totalPlots")}</span><strong className="bidi-isolate">{dashboard.plots.length}</strong></article>
          <article><span>{t("farmMap.totalTrees")}</span><strong className="bidi-isolate">{formatNumber(totalTrees)}</strong></article>
          <article><span>{t("farmMap.irrigationOverdue")}</span><strong className="bidi-isolate">{dashboard.plotStatusSummary.filter((item) => item.statuses.irrigation === "overdue").length}</strong></article>
          <article><span>{t("farmMap.fertilizerDue")}</span><strong className="bidi-isolate">{dashboard.plotStatusSummary.filter((item) => ["overdue", "due_soon"].includes(item.statuses.fertilizer)).length}</strong></article>
          <article><span>{t("farmMap.pesticideDue")}</span><strong className="bidi-isolate">{dashboard.plotStatusSummary.filter((item) => ["overdue", "due_soon"].includes(item.statuses.pesticide)).length}</strong></article>
          <article><span>{t("farmMap.completedToday")}</span><strong className="bidi-isolate">{dashboard.completedTodayCount}</strong></article>
          <article><span>{t("farmMap.totalPumps")}</span><strong className="bidi-isolate">{dashboard.waterAssets.filter((item) => item.assetType === "pump").length}</strong></article>
          <article><span>{t("farmMap.totalReservoirs")}</span><strong className="bidi-isolate">{dashboard.waterAssets.filter((item) => item.assetType === "reservoir").length}</strong></article>
        </section>
        <section className="farm-map-workspace">
          <div className="farm-map-panel">
            <div className="farm-map-toolbar">
              <div className="farm-map-layer-toggles">
                {(["plots", "irrigation", "valves", "pumps", "reservoirs"] as const).map((key) => <button className={layers[key] ? "is-active" : ""} type="button" key={key} onClick={() => setLayers({ ...layers, [key]: !layers[key] })}><Layers size={15} />{layerLabels[key]}</button>)}
              </div>
              <div className="farm-map-layer-toggles">
                {(["irrigation", "fertilizer", "pesticide"] as OperationActivityType[]).map((key) => <button className={activeStatus === key ? "is-active" : ""} type="button" key={key} onClick={() => setActiveStatus(key)}>{translateStatus(t, key)}</button>)}
              </div>
            </div>
            <MapCanvas dashboard={dashboard} activeStatus={activeStatus} layers={layers} onSelect={setSelected} assetMode={assetMode} onMapPoint={setAssetPoint} />
          </div>
          <aside className="farm-map-side">
            <div className="farm-map-actions">
              <Link to={`/workspace/${workspaceId}/farms/${farmId}/operations-map`}><MapPinned size={16} />{t("farmMap.liveMapAction")}</Link>
              <Link to={`/workspace/${workspaceId}/farms/${farmId}/map-builder`}><Upload size={16} />{t("farmMap.builderAction")}</Link>
              <button type="button" onClick={() => quickLog("irrigation", selected)}><Droplets size={16} />{t("farmMap.logIrrigationAction")}</button>
              <button type="button" onClick={() => quickLog("fertilizer", selected)}><FlaskConical size={16} />{t("farmMap.logFertilizerAction")}</button>
              <button type="button" onClick={() => quickLog("pesticide", selected)}><SprayCan size={16} />{t("farmMap.logSprayAction")}</button>
            </div>
            {selectedStatus && <StatusBadges statuses={selectedStatus} />}
            <section className="farm-due-panel">
              <h2><CalendarClock size={17} />{t("farmMap.dueWork")}</h2>
              {dashboard.dueWorkList.slice(0, 10).map((item) => {
                const plot = dashboard.plots.find((row) => row.id === item.plotId);
                return <article key={`${item.plotId}:${item.activityType}`}><strong className="bidi-isolate">{plot?.plotCode ?? t("farmMap.plotLabel")}</strong><span>{t("farmMap.activityStatusLabel", { activity: translateStatus(t, item.activityType), status: translateStatus(t, item.status) })}</span></article>;
              })}
              {!dashboard.dueWorkList.length && <p>{t("farmMap.noDueWork")}</p>}
            </section>
          </aside>
        </section>
        {mode === "builder" && canManage && <section className="farm-builder-grid">
          <label className="farm-show-inactive">
            <input checked={showInactive} type="checkbox" onChange={(event) => setShowInactive(event.target.checked)} />
            {t("farmMap.showInactive")}
          </label>
          <form className="record-panel farm-builder-form" onSubmit={saveMap}>
            <h2>{t("farmMap.mapSetup")}</h2>
            <input placeholder={t("farmMap.mapNamePlaceholder")} value={mapForm.mapName} onChange={(event) => setMapForm({ ...mapForm, mapName: event.target.value })} />
            <input inputMode="decimal" placeholder={t("farmMap.centerLatPlaceholder")} value={mapForm.centerLat} onChange={(event) => setMapForm({ ...mapForm, centerLat: event.target.value })} />
            <input inputMode="decimal" placeholder={t("farmMap.centerLngPlaceholder")} value={mapForm.centerLng} onChange={(event) => setMapForm({ ...mapForm, centerLng: event.target.value })} />
            <input inputMode="decimal" placeholder={t("farmMap.defaultZoomPlaceholder")} value={mapForm.defaultZoom} onChange={(event) => setMapForm({ ...mapForm, defaultZoom: event.target.value })} />
            <textarea placeholder={t("farmMap.notesLabel")} value={mapForm.notes} onChange={(event) => setMapForm({ ...mapForm, notes: event.target.value })} />
            <button type="submit"><Save size={16} />{t("farmMap.saveMapAction")}</button>
          </form>
          <section className="record-panel farm-water-builder">
            <header>
              <h2>{t("farmMap.waterInfrastructure")}</h2>
              <div>
                <button type="button" className={assetMode === "pump" ? "is-active" : ""} onClick={() => beginWaterAsset("pump")}><Plus size={16} />{t("farmMap.addPumpAction")}</button>
                <button type="button" className={assetMode === "reservoir" ? "is-active" : ""} onClick={() => beginWaterAsset("reservoir")}><Plus size={16} />{t("farmMap.addReservoirAction")}</button>
              </div>
            </header>
            {assetMode && <form className="farm-builder-form" onSubmit={saveWaterAsset}>
              <p>{assetPoint ? <>{t("farmMap.locationSelectedLabel")} <span className="bidi-isolate">{`${assetPoint.lat.toFixed(6)}, ${assetPoint.lng.toFixed(6)}`}</span></> : t("farmMap.clickMapEnterCodeName")}</p>
              <input required placeholder={t("farmMap.assetCodePlaceholder")} value={assetForm.assetCode} onChange={(event) => setAssetForm({ ...assetForm, assetCode: event.target.value })} />
              <input required placeholder={t("farmMap.assetNamePlaceholder")} value={assetForm.assetName} onChange={(event) => setAssetForm({ ...assetForm, assetName: event.target.value })} />
              <input placeholder={t("common.status")} value={assetForm.status} onChange={(event) => setAssetForm({ ...assetForm, status: event.target.value })} />
              <textarea placeholder={t("farmMap.notesLabel")} value={assetForm.notes} onChange={(event) => setAssetForm({ ...assetForm, notes: event.target.value })} />
              <div className="farm-water-builder__actions">
                <button type="submit" disabled={(!editingIds.waterAsset && !assetPoint) || saveResource.isPending}><Save size={16} />{t("farmMap.saveAssetButton", { action: editingIds.waterAsset ? t("common.update") : t("common.save"), assetLabel: assetMode === "pump" ? t("farmMap.pumpBoreholeLower") : t("farmMap.reservoirLower") })}</button>
                <button className="secondary-button" type="button" onClick={resetWaterAssetForm}>{t("common.cancel")}</button>
              </div>
            </form>}
            <RecordManagerList
              title={t("farmMap.existingWaterAssets")}
              items={managedWaterAssets}
              getLabel={(item) => `${item.assetCode} ${item.assetName}`}
              getMeta={(item) => `${item.assetType === "pump" ? t("farmMap.pumpBoreholeLabel") : t("farmMap.reservoirLabel")} • ${item.status || t("farmMap.noStatusFallback")}${item.active ? "" : ` • ${t("common.inactive")}`}`}
              onEdit={startEditWaterAsset}
              onDelete={(item) => void requestDelete("water-assets", item.id, item.assetName, {
                seasonId: item.seasonId,
                assetType: item.assetType,
                assetCode: item.assetCode,
                assetName: item.assetName,
                linkedFeatureId: item.linkedFeatureId ?? "",
                status: item.status ?? "",
                notes: item.notes ?? "",
                active: item.active,
              })}
            />
          </section>
          <section className="record-panel farm-kml-import">
            <header>
              <div>
                <h2><Upload size={17} />{t("farmMap.kmlImportTitle")}</h2>
                <p>{t("farmMap.kmlImportDescription")}</p>
              </div>
              <label className="farm-file-picker">
                <Upload size={16} />
                {t("farmMap.chooseKmlKmz")}
                <input accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz" type="file" onChange={(event) => void uploadKml(event.target.files?.[0] ?? null)} />
              </label>
            </header>
            {importFilename && <p className="farm-import-meta"><span className="bidi-isolate">{importFilename}</span> | {t("farmMap.detectedFeaturesCount", { count: importRows.length })}</p>}
            {importError && <p className="error">{importError}</p>}
            {importRows.length > 0 && <>
              <div className="farm-import-table-wrap">
                <table className="farm-import-table">
                  <thead><tr><th>{t("farmMap.importColumn")}</th><th>{t("farmMap.nameColumn")}</th><th>{t("farmMap.geometryColumn")}</th><th>{t("farmMap.mapAsColumn")}</th><th>{t("farmMap.coordinatesColumn")}</th></tr></thead>
                  <tbody>
                    {importRows.map((row) => {
                      const coordinates = row.geojson.coordinates as unknown[];
                      return <tr key={row.id}>
                        <td><input aria-label={t("farmMap.importRowAriaLabel", { name: row.featureName })} type="checkbox" checked={row.selected} onChange={(event) => updateImportRow(row.id, { selected: event.target.checked })} /></td>
                        <td><input value={row.featureName} onChange={(event) => updateImportRow(row.id, { featureName: event.target.value })} /></td>
                        <td>{translateStatus(t, row.geometryType)}</td>
                        <td><select value={row.featureType} onChange={(event) => updateImportRow(row.id, { featureType: event.target.value as FarmFeatureType })}>{geometryFeatureTypes(row.geometryType).map((type) => <option key={type} value={type}>{translateStatus(t, type)}</option>)}</select></td>
                        <td className="bidi-isolate">{Array.isArray(coordinates[0]) ? coordinates.length : 1}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
              <footer>
                <button type="button" disabled={saveResource.isPending} onClick={() => void saveImportRows()}><Save size={16} />{t("farmMap.saveSelectedFeaturesAction")}</button>
                <button className="secondary-button" type="button" onClick={() => setImportRows([])}>{t("farmMap.clearPreviewAction")}</button>
              </footer>
            </>}
          </section>
          <form className="record-panel farm-builder-form" onSubmit={saveFeature}>
            <h2>{editingIds.feature ? t("farmMap.editGeoJsonFeatureTitle") : t("farmMap.geoJsonFeatureTitle")}</h2>
            <select value={featureForm.featureType} onChange={(event) => setFeatureForm({ ...featureForm, featureType: event.target.value })}>{featureTypeOptions.map((item) => <option key={item} value={item}>{translateStatus(t, item)}</option>)}</select>
            <input placeholder={t("farmMap.featureCodePlaceholder")} value={featureForm.featureCode} onChange={(event) => setFeatureForm({ ...featureForm, featureCode: event.target.value })} />
            <input required placeholder={t("farmMap.featureNamePlaceholder")} value={featureForm.featureName} onChange={(event) => setFeatureForm({ ...featureForm, featureName: event.target.value })} />
            <textarea required placeholder={t("farmMap.pasteGeoJsonPlaceholder")} value={featureForm.geojsonText} onChange={(event) => setFeatureForm({ ...featureForm, geojsonText: event.target.value })} />
            <select value={featureForm.linkedPlotId} onChange={(event) => setFeatureForm({ ...featureForm, linkedPlotId: event.target.value })}><option value="">{t("farmMap.linkPlotLaterOption")}</option>{dashboard.plots.map((plot) => <option key={plot.id} value={plot.id}>{plot.plotCode}</option>)}</select>
            <select value={featureForm.linkedIrrigationLineId} onChange={(event) => setFeatureForm({ ...featureForm, linkedIrrigationLineId: event.target.value })}><option value="">{t("farmMap.linkLineLaterOption")}</option>{dashboard.irrigationLines.map((line) => <option key={line.id} value={line.id}>{line.lineCode}</option>)}</select>
            <select value={featureForm.linkedValveId} onChange={(event) => setFeatureForm({ ...featureForm, linkedValveId: event.target.value })}><option value="">{t("farmMap.linkValveLaterOption")}</option>{dashboard.valves.map((valve) => <option key={valve.id} value={valve.id}>{valve.valveCode}</option>)}</select>
            <div className="farm-form-actions">
              <button type="submit"><Plus size={16} />{editingIds.feature ? t("farmMap.updateFeatureAction") : t("farmMap.importFeatureAction")}</button>
              {editingIds.feature && <button className="secondary-button" type="button" onClick={resetFeatureForm}>{t("common.cancel")}</button>}
            </div>
            <RecordManagerList
              title={t("farmMap.existingMapFeatures")}
              items={managedFeatures}
              getLabel={(item) => item.featureName}
              getMeta={(item) => `${translateStatus(t, item.featureType)}${item.active ? "" : ` • ${t("common.inactive")}`}`}
              onEdit={startEditFeature}
              onDelete={(item) => void requestDelete("features", item.id, item.featureName, {
                seasonId: item.seasonId,
                featureType: item.featureType,
                featureCode: item.featureCode ?? "",
                featureName: item.featureName,
                geojson: item.geojson,
                linkedPlotId: item.linkedPlotId ?? "",
                linkedIrrigationLineId: item.linkedIrrigationLineId ?? "",
                linkedValveId: item.linkedValveId ?? "",
                styleJson: item.styleJson,
                displayOrder: item.displayOrder,
                active: item.active,
              })}
            />
          </form>
          <BuilderForms
            dashboard={dashboard}
            plotForm={plotForm}
            setPlotForm={setPlotForm}
            lineForm={lineForm}
            setLineForm={setLineForm}
            valveForm={valveForm}
            setValveForm={setValveForm}
            editingIds={editingIds}
            resetPlotForm={resetPlotForm}
            resetLineForm={resetLineForm}
            resetValveForm={resetValveForm}
            saveResource={(input, onSuccess) => saveResource.mutate(input, { onSuccess })}
            plots={managedPlots}
            lines={managedLines}
            valves={managedValves}
            onEditPlot={startEditPlot}
            onEditLine={startEditLine}
            onEditValve={startEditValve}
            onDeletePlot={(plot) => void requestDelete("plots", plot.id, plot.plotCode, { ...plot, plotName: plot.plotName ?? "", variety: plot.variety ?? "", area: plot.area ?? "", notes: plot.notes ?? "", geoFeatureId: plot.geoFeatureId ?? "" })}
            onDeleteLine={(line) => void requestDelete("irrigation-lines", line.id, line.lineCode, { ...line, lineName: line.lineName ?? "", description: line.description ?? "", geoFeatureId: line.geoFeatureId ?? "" })}
            onDeleteValve={(valve) => void requestDelete("valves", valve.id, valve.valveCode, { ...valve, valveName: valve.valveName ?? "", irrigationLineId: valve.irrigationLineId ?? "", plotId: valve.plotId ?? "", notes: valve.notes ?? "", geoFeatureId: valve.geoFeatureId ?? "" })}
          />
          <form className="record-panel farm-builder-form" onSubmit={saveRule}>
            <h2>{editingIds.rule ? t("farmMap.editDueRuleTitle") : t("farmMap.dueRuleTitle")}</h2>
            <select value={ruleForm.plotId} onChange={(event) => setRuleForm({ ...ruleForm, plotId: event.target.value })}><option value="">{t("farmMap.allPlotsOption")}</option>{dashboard.plots.map((plot) => <option key={plot.id} value={plot.id}>{plot.plotCode}</option>)}</select>
            <select value={ruleForm.activityType} onChange={(event) => setRuleForm({ ...ruleForm, activityType: event.target.value as OperationActivityType })}>{activityOptions.map((item) => <option key={item} value={item}>{translateStatus(t, item)}</option>)}</select>
            <input inputMode="numeric" placeholder={t("farmMap.intervalDaysPlaceholder")} value={ruleForm.intervalDays} onChange={(event) => setRuleForm({ ...ruleForm, intervalDays: event.target.value })} />
            <input inputMode="numeric" placeholder={t("farmMap.dueSoonDaysPlaceholder")} value={ruleForm.dueSoonDays} onChange={(event) => setRuleForm({ ...ruleForm, dueSoonDays: event.target.value })} />
            <textarea placeholder={t("farmMap.notesLabel")} value={ruleForm.notes} onChange={(event) => setRuleForm({ ...ruleForm, notes: event.target.value })} />
            <div className="farm-form-actions">
              <button type="submit"><Save size={16} />{editingIds.rule ? t("farmMap.updateRuleAction") : t("farmMap.saveRuleAction")}</button>
              {editingIds.rule && <button className="secondary-button" type="button" onClick={resetRuleForm}>{t("common.cancel")}</button>}
            </div>
            <RecordManagerList
              title={t("farmMap.existingDueRules")}
              items={managedRules}
              getLabel={(item) => t("farmMap.ruleFrequencyLabel", { activity: translateStatus(t, item.activityType), days: item.intervalDays })}
              getMeta={(item) => `${dashboard.plots.find((plot) => plot.id === item.plotId)?.plotCode ?? t("farmMap.allPlotsOption")}${item.active ? "" : ` • ${t("common.inactive")}`}`}
              onEdit={startEditRule}
              onDelete={(item) => void requestDelete("operation-due-rules", item.id, t("farmMap.ruleDeleteLabel", { activity: translateStatus(t, item.activityType) }))}
            />
          </form>
        </section>}
        {showLog && <section className="record-panel farm-log-panel">
          <header><h2>{editingIds.log ? t("farmMap.editOperationEntryTitle") : logForm.activityType === "irrigation" ? t("farmMap.logIrrigationTitle") : logForm.activityType === "fertilizer" ? t("farmMap.logFertilizerTitle") : t("farmMap.logSprayTitle")}</h2><button type="button" onClick={() => { resetLogForm(); setShowLog(false); }}>{t("common.close")}</button></header>
          <OperationLogForm dashboard={dashboard} products={products.data?.records ?? []} initial={logForm} onSubmit={submitLog} pending={saveResource.isPending} onChangeLocation={() => { setShowLog(false); }} />
        </section>}
        <section className="record-panel farm-logs-report" ref={logsSectionRef}>
          <h2>{t("farmMap.operationLogsReportTitle")}</h2>
          <div className="attendance-import-table-wrap report-wide-table">
            <table className="report-data-table"><thead><tr><th>{t("farmMap.dateColumn")}</th><th>{t("farmMap.activityColumn")}</th><th>{t("farmMap.plotLabel")}</th><th>{t("farmMap.valveLabel")}</th><th>{t("farmMap.productColumn")}</th><th>{t("farmMap.qtyColumn")}</th><th>{t("farmMap.performedByColumn")}</th><th>{t("farmMap.remarksColumn")}</th><th>{t("farmMap.actionsColumn")}</th></tr></thead><tbody>
              {logs.map((log) => <tr key={log.id}><td className="bidi-isolate">{log.operationDate}</td><td>{translateStatus(t, log.activityType)}</td><td className="bidi-isolate">{dashboard.plots.find((plot) => plot.id === log.plotId)?.plotCode ?? "-"}</td><td className="bidi-isolate">{dashboard.valves.find((valve) => valve.id === log.valveId)?.valveCode ?? "-"}</td><td>{products.data?.records.find((product) => product.id === log.productId)?.productName ?? log.productNameText ?? "-"}</td><td className="bidi-isolate">{log.totalQty ?? "-"} {log.unit ?? ""}</td><td>{log.performedBy ?? "-"}</td><td>{log.remarks ?? "-"}</td><td><div className="farm-table-actions"><button type="button" onClick={() => startEditLog(log)}><Pencil size={14} />{t("common.edit")}</button><button className="danger-button" type="button" onClick={() => void requestDelete("operation-logs", log.id, t("farmMap.operationLogLabel"))}><Trash2 size={14} />{t("common.delete")}</button></div></td></tr>)}
            </tbody></table>
          </div>
          <div className="report-wide-table--mobile report-mobile-cards">
            {logs.map((log) => <article className="report-mobile-card" key={`mobile-${log.id}`}>
              <b>{translateStatus(t, log.activityType)} • <span className="bidi-isolate">{log.operationDate}</span></b>
              <p className="bidi-isolate">{dashboard.plots.find((plot) => plot.id === log.plotId)?.plotCode ?? "-"} • {dashboard.valves.find((valve) => valve.id === log.valveId)?.valveCode ?? "-"}</p>
              <p>{products.data?.records.find((product) => product.id === log.productId)?.productName ?? log.productNameText ?? "-"}</p>
              <p><span className="bidi-isolate">{log.totalQty ?? "-"} {log.unit ?? ""}</span> • {log.performedBy ?? "-"}</p>
              <div className="farm-table-actions"><button type="button" onClick={() => startEditLog(log)}><Pencil size={14} />{t("common.edit")}</button><button className="danger-button" type="button" onClick={() => void requestDelete("operation-logs", log.id, t("farmMap.operationLogLabel"))}><Trash2 size={14} />{t("common.delete")}</button></div>
            </article>)}
          </div>
        </section>
        <SideDrawer
          selected={selected}
          dashboard={dashboard}
          logs={logs}
          mode={mode}
          builderHref={`/workspace/${workspaceId}/farms/${farmId}/map-builder`}
          onClose={() => setSelected(null)}
          onQuickLog={quickLog}
          onEditPlot={startEditPlot}
          onEditLine={startEditLine}
          onEditValve={startEditValve}
          onEditWaterAsset={startEditWaterAsset}
          onDeactivatePlot={(plot) => void requestDelete("plots", plot.id, plot.plotCode, { ...plot, plotName: plot.plotName ?? "", variety: plot.variety ?? "", area: plot.area ?? "", notes: plot.notes ?? "", geoFeatureId: plot.geoFeatureId ?? "" })}
          onDeactivateLine={(line) => void requestDelete("irrigation-lines", line.id, line.lineCode, { ...line, lineName: line.lineName ?? "", description: line.description ?? "", geoFeatureId: line.geoFeatureId ?? "" })}
          onDeactivateValve={(valve) => void requestDelete("valves", valve.id, valve.valveCode, { ...valve, valveName: valve.valveName ?? "", irrigationLineId: valve.irrigationLineId ?? "", plotId: valve.plotId ?? "", notes: valve.notes ?? "", geoFeatureId: valve.geoFeatureId ?? "" })}
          onDeleteWaterAsset={(asset) => void requestDelete("water-assets", asset.id, asset.assetName, {
            seasonId: asset.seasonId,
            assetType: asset.assetType,
            assetCode: asset.assetCode,
            assetName: asset.assetName,
            linkedFeatureId: asset.linkedFeatureId ?? "",
            status: asset.status ?? "",
            notes: asset.notes ?? "",
            active: asset.active,
          })}
          onViewHistory={viewSelectedHistory}
        />
      </>}
    </main>
  </div>;
}

function BuilderForms({
  dashboard,
  plotForm,
  setPlotForm,
  lineForm,
  setLineForm,
  valveForm,
  setValveForm,
  editingIds,
  resetPlotForm,
  resetLineForm,
  resetValveForm,
  saveResource,
  plots,
  lines,
  valves,
  onEditPlot,
  onEditLine,
  onEditValve,
  onDeletePlot,
  onDeleteLine,
  onDeleteValve,
}: {
  dashboard: NonNullable<ReturnType<typeof useDashboardData>["dashboard"]>;
  plotForm: PlotForm;
  setPlotForm: (form: PlotForm) => void;
  lineForm: LineForm;
  setLineForm: (form: LineForm) => void;
  valveForm: ValveForm;
  setValveForm: (form: ValveForm) => void;
  editingIds: { plot: string | null; line: string | null; valve: string | null };
  resetPlotForm: () => void;
  resetLineForm: () => void;
  resetValveForm: () => void;
  saveResource: (input: { resource: string; input: unknown; id?: string }, onSuccess?: () => void) => void;
  plots: FarmPlot[];
  lines: IrrigationLine[];
  valves: FarmValve[];
  onEditPlot: (plot: FarmPlot) => void;
  onEditLine: (line: IrrigationLine) => void;
  onEditValve: (valve: FarmValve) => void;
  onDeletePlot: (plot: FarmPlot) => void;
  onDeleteLine: (line: IrrigationLine) => void;
  onDeleteValve: (valve: FarmValve) => void;
}) {
  const { t } = useTranslation();
  const numeric = (value: string) => value ? Number(value) : null;
  const features = dashboard.features;
  const submit = (resource: string, input: unknown, id: string | null | undefined, onSuccess: () => void) => (event: FormEvent) => {
    event.preventDefault();
    saveResource({ resource, input, id: id ?? undefined }, onSuccess);
  };
  return <>
    <form className="record-panel farm-builder-form" onSubmit={submit("plots", { ...plotForm, treeCount: numeric(plotForm.treeCount), area: numeric(plotForm.area) }, editingIds.plot, resetPlotForm)}>
      <h2>{editingIds.plot ? t("farmMap.editPlotRecordTitle") : t("farmMap.plotRecordTitle")}</h2><input required placeholder={t("farmMap.plotCodePlaceholder")} value={plotForm.plotCode} onChange={(event) => setPlotForm({ ...plotForm, plotCode: event.target.value })} /><input placeholder={t("farmMap.plotNamePlaceholder")} value={plotForm.plotName} onChange={(event) => setPlotForm({ ...plotForm, plotName: event.target.value })} /><input placeholder={t("farmMap.varietyPlaceholder")} value={plotForm.variety} onChange={(event) => setPlotForm({ ...plotForm, variety: event.target.value })} /><input inputMode="numeric" placeholder={t("farmMap.treeCountPlaceholder")} value={plotForm.treeCount} onChange={(event) => setPlotForm({ ...plotForm, treeCount: event.target.value })} /><select value={plotForm.geoFeatureId} onChange={(event) => setPlotForm({ ...plotForm, geoFeatureId: event.target.value })}><option value="">{t("farmMap.linkFeatureLaterOption")}</option>{features.filter((item) => item.featureType === "plot").map((item) => <option key={item.id} value={item.id}>{item.featureName}</option>)}</select><div className="farm-form-actions"><button type="submit"><Plus size={16} />{editingIds.plot ? t("farmMap.updatePlotAction") : t("farmMap.savePlotAction")}</button>{editingIds.plot && <button className="secondary-button" type="button" onClick={resetPlotForm}>{t("common.cancel")}</button>}</div>
      <RecordManagerList title={t("farmMap.existingPlots")} items={plots} getLabel={(item) => item.plotCode} getMeta={(item) => `${item.plotName ?? t("farmMap.unnamedPlot")}${item.active ? "" : ` • ${t("common.inactive")}`}`} onEdit={onEditPlot} onDelete={onDeletePlot} />
    </form>
    <form className="record-panel farm-builder-form" onSubmit={submit("irrigation-lines", lineForm, editingIds.line, resetLineForm)}>
      <h2>{editingIds.line ? t("farmMap.editIrrigationLineTitle") : t("farmMap.irrigationLineLabel")}</h2><input required placeholder={t("farmMap.lineCodePlaceholder")} value={lineForm.lineCode} onChange={(event) => setLineForm({ ...lineForm, lineCode: event.target.value })} /><input placeholder={t("farmMap.lineNamePlaceholder")} value={lineForm.lineName} onChange={(event) => setLineForm({ ...lineForm, lineName: event.target.value })} /><textarea placeholder={t("farmMap.descriptionPlaceholder")} value={lineForm.description} onChange={(event) => setLineForm({ ...lineForm, description: event.target.value })} /><select value={lineForm.geoFeatureId} onChange={(event) => setLineForm({ ...lineForm, geoFeatureId: event.target.value })}><option value="">{t("farmMap.linkFeatureLaterOption")}</option>{features.filter((item) => item.featureType === "irrigation_line").map((item) => <option key={item.id} value={item.id}>{item.featureName}</option>)}</select><div className="farm-form-actions"><button type="submit"><Plus size={16} />{editingIds.line ? t("farmMap.updateLineAction") : t("farmMap.saveLineAction")}</button>{editingIds.line && <button className="secondary-button" type="button" onClick={resetLineForm}>{t("common.cancel")}</button>}</div>
      <RecordManagerList title={t("farmMap.existingIrrigationLines")} items={lines} getLabel={(item) => item.lineCode} getMeta={(item) => `${item.lineName ?? t("farmMap.unnamedLine")}${item.active ? "" : ` • ${t("common.inactive")}`}`} onEdit={onEditLine} onDelete={onDeleteLine} />
    </form>
    <form className="record-panel farm-builder-form" onSubmit={submit("valves", { ...valveForm, estimatedTreeCount: numeric(valveForm.estimatedTreeCount) }, editingIds.valve, resetValveForm)}>
      <h2>{editingIds.valve ? t("farmMap.editValve") : t("farmMap.valveLabel")}</h2><input required placeholder={t("farmMap.valveCodePlaceholder")} value={valveForm.valveCode} onChange={(event) => setValveForm({ ...valveForm, valveCode: event.target.value })} /><input placeholder={t("farmMap.valveNamePlaceholder")} value={valveForm.valveName} onChange={(event) => setValveForm({ ...valveForm, valveName: event.target.value })} /><select value={valveForm.irrigationLineId} onChange={(event) => setValveForm({ ...valveForm, irrigationLineId: event.target.value })}><option value="">{t("farmMap.irrigationLineLabel")}</option>{dashboard.irrigationLines.map((item: IrrigationLine) => <option key={item.id} value={item.id}>{item.lineCode}</option>)}</select><select value={valveForm.plotId} onChange={(event) => setValveForm({ ...valveForm, plotId: event.target.value })}><option value="">{t("farmMap.plotLabel")}</option>{dashboard.plots.map((item: FarmPlot) => <option key={item.id} value={item.id}>{item.plotCode}</option>)}</select><input inputMode="numeric" placeholder={t("farmMap.estimatedTreesPlaceholder")} value={valveForm.estimatedTreeCount} onChange={(event) => setValveForm({ ...valveForm, estimatedTreeCount: event.target.value })} /><select value={valveForm.geoFeatureId} onChange={(event) => setValveForm({ ...valveForm, geoFeatureId: event.target.value })}><option value="">{t("farmMap.linkFeatureLaterOption")}</option>{features.filter((item) => item.featureType === "valve").map((item) => <option key={item.id} value={item.id}>{item.featureName}</option>)}</select><div className="farm-form-actions"><button type="submit"><Plus size={16} />{editingIds.valve ? t("farmMap.updateValveAction") : t("farmMap.saveValveAction")}</button>{editingIds.valve && <button className="secondary-button" type="button" onClick={resetValveForm}>{t("common.cancel")}</button>}</div>
      <RecordManagerList title={t("farmMap.existingValves")} items={valves} getLabel={(item) => item.valveCode} getMeta={(item) => `${item.valveName ?? t("farmMap.unnamedValve")}${item.active ? "" : ` • ${t("common.inactive")}`}`} onEdit={onEditValve} onDelete={onDeleteValve} />
    </form>
  </>;
}

function RecordManagerList<T>({
  title,
  items,
  getLabel,
  getMeta,
  onEdit,
  onDelete,
}: {
  title: string;
  items: T[];
  getLabel: (item: T) => string;
  getMeta: (item: T) => string;
  onEdit: (item: T) => void;
  onDelete: (item: T) => void;
}) {
  const { t } = useTranslation();
  return <div className="farm-record-list">
    <h3>{title}</h3>
    {!items.length && <p className="context-message">{t("farmMap.noRecordsYet")}</p>}
    {items.map((item, index) => <article className="farm-record-list__item" key={index}>
      <div>
        <strong>{getLabel(item)}</strong>
        <small>{getMeta(item)}</small>
      </div>
      <div className="farm-table-actions">
        <button type="button" onClick={() => onEdit(item)}><Pencil size={14} />{t("common.edit")}</button>
        <button className="danger-button" type="button" onClick={() => onDelete(item)}><Trash2 size={14} />{t("common.delete")}</button>
      </div>
    </article>)}
  </div>;
}
