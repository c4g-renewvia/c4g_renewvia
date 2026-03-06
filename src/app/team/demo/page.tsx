'use client';

import React, { useEffect, useRef, useState, ChangeEvent } from 'react';
import Script from 'next/script';
import Papa from 'papaparse';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogFooter,
} from '@/components/ui/dialog';

import { useSession } from 'next-auth/react';

const GOOGLE_MAPS_API_KEY =
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || 'YOUR_GOOGLE_MAPS_API_KEY';

function toLiteral(
  pos: google.maps.marker.AdvancedMarkerElement['position']
): google.maps.LatLngLiteral | null {
  if (!pos) return null;

  if (typeof pos.lat === 'function' && typeof pos.lng === 'function') {
    // It's a LatLng / LatLngAltitude instance
    return {
      lat: pos.lat(),
      lng: pos.lng(),
    };
  }

  // Already a literal
  return {
    lat: pos.lat as number,
    lng: pos.lng as number,
  };
}

const haversineDistance = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
) => {
  const R = 6371e3; // Radius of the Earth in kilometers

  // Function to convert degrees to radians
  const deg2rad = (deg: number) => {
    return deg * (Math.PI / 180);
  };

  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) *
      Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2); // The Haversine formula part 'a'

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); // Angular distance 'c'

  const distance = R * c; // Distance 'd' = R * c
  return distance;
};

interface MiniGridRun {
  id: string;
  name?: string;
  createdAt: string; // or Date if you convert it
  fileName?: string | null;
  dataPoints: LocationPoint[];
  mstNodes: MSTNode[];
  mstEdges: MSTEdge[];
  costBreakdown?: CostBreakdown | null;
  poleCost: number;
  lowVoltageCost: number;
  highVoltageCost: number;
  // add any other fields you actually use from the API
}

const formatMeters = (m: number) =>
  m.toLocaleString(undefined, { maximumFractionDigits: 0 });
const formatUSD = (v: number) =>
  v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const highVoltageColor = '#8B5CF6';
const lowVoltageColor = '#3B82F6';

interface LocationPoint {
  name: string;
  type: 'source' | 'terminal' | 'pole';
  lat: number;
  lng: number;
}

interface MSTEdge {
  start: { lat: number; lng: number };
  end: { lat: number; lng: number };
  lengthMeters: number;
  voltage: 'low' | 'high';
}

interface MSTNode {
  index: number;
  lat: number;
  lng: number;
  name: string;
  type: 'source' | 'terminal' | 'pole';
}

interface CostBreakdown {
  lowVoltageMeters: number;
  highVoltageMeters: number;
  totalMeters: number;

  lowWireCost: number;
  highWireCost: number;
  wireCost: number;

  poleCount: number;
  poleCost: number;
  pointCount: number;

  grandTotal: number;

  // Debug / transparency
  usedPoleCost?: number;
  usedLowCostPerMeter?: number;
  usedHighCostPerMeter?: number;
}

export default function DemoPage() {
  const mapRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const polylinesRef = useRef<google.maps.Polyline[]>([]);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const markerDragRef = useRef<string>(null);
  const [dataPoints, setDataPoints] = useState<LocationPoint[]>([]);
  const [mstEdges, setMstEdges] = useState<MSTEdge[]>([]);
  const [mstNodes, setMstNodes] = useState<MSTNode[]>([]);
  const [computingMst, setComputingMst] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [poleCost, setPoleCost] = useState<number>(100);
  const [lowVoltageCost, setLowVoltageCost] = useState<number>(10);
  const [highVoltageCost, setHighVoltageCost] = useState<number>(20);
  const [calculationResult] = useState<string>('');
  const [calcError, setCalcError] = useState<string | null>(null);

  const [savedRuns, setSavedRuns] = useState<MiniGridRun[]>([]);
  const [loadingSaved, setLoadingSaved] = useState(false);

  const [costBreakdown, setCostBreakdown] = useState<CostBreakdown | null>(
    null
  );
  const [selectedCount, setSelectedCount] = useState<number>(10);
  const [isDragOver, setIsDragOver] = useState(false);

  const [solvers, setSolvers] = useState<string[]>([]);
  const [selectedSolver, setSelectedSolver] =
    useState<string>('SimpleMSTSolver');

  const { data: session } = useSession();

  // Initialize map once Google Maps script loads
  const initMap = () => {
    if (!window.google?.maps || !mapRef.current) return;

    const googleMap = new window.google.maps.Map(mapRef.current, {
      center: { lat: 39.8283, lng: -98.5795 }, // US center fallback
      zoom: 4,
      mapTypeId: 'satellite' as google.maps.MapTypeId,
      fullscreenControl: false,
      streetViewControl: false,
      mapId: 'DEMO_MAP_ID', // Required for AdvancedMarkerElement
    });

    setMap(googleMap);
  };

  // Helper to create a consistent marker for any point/node
  const createMarker = (
    point: {
      lat: number;
      lng: number;
      name: string;
      type?: 'source' | 'terminal' | 'pole';
    },
    map: google.maps.Map
  ) => {
    const type = point.type || 'terminal'; // raw uploaded points → treat as 'terminal'

    let iconUrl = 'http://maps.google.com/mapfiles/ms/icons/';
    let labelColor = 'white';
    let scaledSize = new google.maps.Size(36, 36);
    let fontSize = '13px';

    switch (type) {
      case 'source':
        iconUrl += 'green-dot.png';
        labelColor = '#00ff00'; // bright green
        scaledSize = new google.maps.Size(44, 44);
        break;

      case 'terminal':
        iconUrl += 'blue-dot.png';
        labelColor = 'white';
        // keep default size
        break;

      case 'pole':
        iconUrl += 'yellow-dot.png';
        scaledSize = new google.maps.Size(28, 28);
        fontSize = '11px';
        labelColor = '#ffff99'; // light yellow for visibility
        break;

      default:
        iconUrl += 'red-dot.png';
    }

    // Create custom content for AdvancedMarkerElement
    const content = document.createElement('div');
    content.style.display = 'flex';
    content.style.flexDirection = 'column';
    content.style.alignItems = 'center';
    content.style.position = 'relative';

    const iconImg = document.createElement('img');
    iconImg.src = iconUrl;
    iconImg.style.width = `${scaledSize.width}px`;
    iconImg.style.height = `${scaledSize.height}px`;
    content.appendChild(iconImg);

    const labelSpan = document.createElement('span');
    labelSpan.textContent = point.name;
    labelSpan.style.color = labelColor;
    labelSpan.style.fontSize = fontSize;
    labelSpan.style.fontWeight = 'bold';
    labelSpan.style.textShadow = '0 0 2px black'; // Better visibility on satellite map
    labelSpan.style.marginTop = '2px';
    content.appendChild(labelSpan);

    const marker = new google.maps.marker.AdvancedMarkerElement({
      position: { lat: point.lat, lng: point.lng },
      map,
      content,
      title: point.type ? `${point.name} (${point.type})` : point.name,
      gmpDraggable: true,
    });

    marker.addListener('dragstart', () => {
      const literal = toLiteral(marker.position);
      if (literal) {
        markerDragRef.current = `${literal.lat},${literal.lng}`;
      }
    });

    // drag
    marker.addListener('drag', () => {
      const current = toLiteral(marker.position);
      if (!current) return;

      const curLat = current.lat; // now definitely number
      const curLng = current.lng;

      const prevStr = markerDragRef.current;
      if (!prevStr) return;
      const [prevLat, prevLng] = prevStr.split(',').map(Number);

      const diff = { lowVoltageMeters: 0, highVoltageMeters: 0 };

      polylinesRef.current.forEach((line) => {
        const path = line.getPath();
        if (path.getLength() !== 2) return;

        const start = path.getAt(0);
        const end = path.getAt(1);

        const startLat = start.lat(); // classic LatLng → method
        const startLng = start.lng();
        const endLat = end.lat();
        const endLng = end.lng();

        let changed = false;
        let prevDist = 0;

        const lineType =
          line.get('strokeColor') === lowVoltageColor ? 'low' : 'high';

        if (
          Math.abs(startLat - prevLat) < 1e-9 &&
          Math.abs(startLng - prevLng) < 1e-9
        ) {
          prevDist = haversineDistance(startLat, startLng, endLat, endLng);
          line.setPath([
            { lat: curLat, lng: curLng }, // now safe: numbers
            { lat: endLat, lng: endLng },
          ]);
          changed = true;
        } else if (
          Math.abs(endLat - prevLat) < 1e-9 &&
          Math.abs(endLng - prevLng) < 1e-9
        ) {
          prevDist = haversineDistance(startLat, startLng, endLat, endLng);
          line.setPath([
            { lat: startLat, lng: startLng },
            { lat: curLat, lng: curLng },
          ]);
          changed = true;
        }

        if (changed) {
          const newDist = haversineDistance(
            line.getPath().getAt(0).lat(),
            line.getPath().getAt(0).lng(),
            line.getPath().getAt(1).lat(),
            line.getPath().getAt(1).lng()
          );
          if (lineType === 'low') {
            diff.lowVoltageMeters += newDist - prevDist;
          } else {
            diff.highVoltageMeters += newDist - prevDist;
          }
        }
      });

      setCostBreakdown((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          lowVoltageMeters: prev.lowVoltageMeters + diff.lowVoltageMeters,
          highVoltageMeters: prev.highVoltageMeters + diff.highVoltageMeters,
          totalMeters:
            prev.totalMeters + diff.lowVoltageMeters + diff.highVoltageMeters,
          wireCost:
            prev.wireCost +
            diff.lowVoltageMeters * lowVoltageCost +
            diff.highVoltageMeters * highVoltageCost,
          grandTotal:
            prev.grandTotal +
            diff.lowVoltageMeters * lowVoltageCost +
            diff.highVoltageMeters * highVoltageCost,
        };
      });

      markerDragRef.current = `${curLat},${curLng}`;
    });

    // dragend remains the same
    marker.addListener('dragend', () => {
      markerDragRef.current = null;
    });

    return marker;
  };

  const getSolversURL =
    process.env.NEXT_PUBLIC_GET_SOLVERS || 'http://localhost:8000/solvers';

  useEffect(() => {
    fetch(getSolversURL)
      .then((res) => res.json())
      .then((data) => setSolvers(data.solvers));
  }, []);

  console.log('Solvers:', solvers);

  // Add markers and fit bounds whenever dataPoints or map changes
  // Solved Markers useEffect – single unified logic
  useEffect(() => {
    if (!map) return;

    // 1. Clear all previous markers
    markersRef.current.forEach((marker) => (marker.map = null));
    markersRef.current = [];

    // 2. Choose which dataset to display
    const pointsToShow = mstNodes.length > 0 ? mstNodes : dataPoints;

    if (pointsToShow.length === 0) return;

    const bounds = new google.maps.LatLngBounds();
    let hasValidPoints = false;

    // 3. Create markers + extend bounds
    pointsToShow.forEach((point) => {
      if (isNaN(point.lat) || isNaN(point.lng)) {
        return;
      }

      hasValidPoints = true;

      const marker = createMarker(point, map);
      markersRef.current.push(marker);

      bounds.extend({ lat: point.lat, lng: point.lng });
    });

    // 4. Fit map bounds if we have valid points
    if (hasValidPoints && !bounds.isEmpty()) {
      // Slight delay helps when map is still initializing / resizing
      setTimeout(() => {
        map.fitBounds(bounds, { bottom: 80, left: 80, right: 80, top: 80 });
      }, 120);
    }
  }, [map, dataPoints, mstNodes]); // dependencies are correct
  // Draw lines on map
  useEffect(() => {
    if (!map) return;

    polylinesRef.current.forEach((line) => line.setMap(null));
    polylinesRef.current = [];

    mstEdges.forEach((edge) => {
      if (!edge?.start || !edge?.end) return;

      const color =
        edge.voltage === 'high' ? highVoltageColor : lowVoltageColor;
      const weight = edge.voltage === 'high' ? 6 : 4;

      const polyline = new google.maps.Polyline({
        path: [edge.start, edge.end],
        geodesic: true,
        strokeColor: color,
        strokeOpacity: 0.9,
        strokeWeight: weight,
        map: map,
      });

      polylinesRef.current.push(polyline);
    });
  }, [map, mstEdges]);

  // fit map to uploaded points immediately (before optimization)
  useEffect(() => {
    if (!map) return;

    // Clear previous markers
    markersRef.current.forEach((m) => (m.map = null));
    markersRef.current = [];

    const bounds = new google.maps.LatLngBounds();
    let hasValidPoints = false;

    // Decide which list to render
    const pointsToShow = mstNodes.length > 0 ? mstNodes : dataPoints;

    pointsToShow.forEach((point) => {
      if (isNaN(point.lat) || isNaN(point.lng)) return;
      hasValidPoints = true;

      const marker = createMarker(point, map);
      markersRef.current.push(marker);

      bounds.extend({ lat: point.lat, lng: point.lng });
    });

    // Fit bounds if we have valid points
    if (hasValidPoints && !bounds.isEmpty()) {
      // Small delay helps avoid race conditions with map init
      setTimeout(() => {
        map.fitBounds(bounds, { bottom: 80, left: 80, right: 80, top: 80 });
      }, 150);
    }
  }, [map, dataPoints, mstNodes]);

  // Fetch saved runs when user is logged in
  useEffect(() => {
    if (!session?.user?.id) return;

    const fetchSaved = async () => {
      setLoadingSaved(true);
      try {
        const res = await fetch('/api/minigrids');
        if (res.ok) {
          const data = await res.json();
          setSavedRuns(data);
        }
      } catch (err) {
        console.error('Failed to load saved runs', err);
      } finally {
        setLoadingSaved(false);
      }
    };

    fetchSaved();
  }, [session?.user?.id]);

  const parseKml = (text: string): LocationPoint[] => {
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'application/xml');

    // Optional: check for parse errors
    if (xml.getElementsByTagName('parsererror').length > 0) {
      console.error('KML parsing error');
      return [];
    }

    const placemarks = Array.from(xml.getElementsByTagName('Placemark'));
    const points: LocationPoint[] = [];

    placemarks.forEach((placemark) => {
      // ── Name ───────────────────────────────────────────────
      const nameEl = placemark.getElementsByTagName('name')[0];
      const baseName = nameEl?.textContent?.trim() || 'Unnamed';

      // ── Type from description ──────────────────────────────
      const descEl = placemark.getElementsByTagName('description')[0];
      let pointType: 'source' | 'terminal' = 'terminal'; // default

      if (descEl) {
        const descText = descEl.textContent?.trim() || '';

        // Look for patterns like: "Type: source", "type:source", "source", etc.
        const typeMatch =
          descText.match(/type\s*[:=]\s*(\w+)/i) ||
          descText.match(/\b(source|terminal)\b/i);

        if (typeMatch) {
          const candidate = typeMatch[1]?.toLowerCase();
          if (candidate === 'source' || candidate === 'terminal') {
            pointType = candidate as 'source' | 'terminal';
          }
        }
      }

      // ── Coordinates ────────────────────────────────────────
      const coordsEls = Array.from(
        placemark.getElementsByTagName('coordinates')
      );

      coordsEls.forEach((coordsEl, coordIdx) => {
        const coordsText = coordsEl.textContent?.trim() || '';
        if (!coordsText) return;

        // Take first coordinate pair (ignore altitude if present)
        const firstPair = coordsText.split(/\s+/)[0];
        const parts = firstPair.split(',');
        if (parts.length < 2) return;

        const lon = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        if (isNaN(lat) || isNaN(lon)) return;

        const name =
          coordsEls.length > 1 ? `${baseName}_${coordIdx + 1}` : baseName;

        points.push({
          name,
          type: pointType,
          lat,
          lng: lon, // note: you're already swapping to {lat, lng}
        });
      });
    });

    return points;
  };

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow uploading the same file name again
    if (!file) return;

    processFile(file);
  };

  const processFile = (file: File) => {
    setMstEdges([]);
    setMstNodes([]);
    setCostBreakdown(null);
    setCalcError(null);
    setError(null);
    setDataPoints([]);
    setFileName(file.name);
    setLoading(true);

    const lowerName = file.name.toLowerCase();

    if (lowerName.endsWith('.kml')) {
      // ── KML branch ─────────────────────────────────────
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        try {
          const parsedPoints = parseKml(text);
          console.log('Parsed KML:', parsedPoints);
          if (parsedPoints.length === 0) {
            setError('No valid placemarks found in the KML file.');
            setDataPoints([]);
          } else {
            setDataPoints(parsedPoints);
          }
        } catch (err) {
          setError('Error parsing KML file.');
          console.error(err);
        } finally {
          setLoading(false);
        }
      };
      reader.onerror = () => {
        setError('Failed to read KML file.');
        setLoading(false);
      };
      reader.readAsText(file);
    } else {
      // ── CSV branch (PapaParse) ─────────────────────────
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim().toLowerCase(),
        complete: (result) => {
          try {
            const rows = result.data as Record<string, string>[];

            const parsedPoints: LocationPoint[] = rows
              .map((row) => {
                const name = row.name?.trim() || row['name'] || 'Unnamed';
                const typeStr = row.type?.trim() || row['type'] || 'terminal';
                const latStr = row.latitude || row.lat || '';
                const lngStr = row.longitude || row.lng || row.logitude || '';

                const lat = parseFloat(latStr);
                const lng = parseFloat(lngStr);

                if (isNaN(lat) || isNaN(lng)) return null;

                const type =
                  typeStr.toLowerCase() === 'source' ? 'source' : 'terminal';

                return { name, type, lat, lng };
              })
              .filter((p): p is LocationPoint => p !== null);

            console.log('Parsed CSV:', parsedPoints);

            if (parsedPoints.length === 0) {
              setError(
                'No valid rows found. Expected columns: Name, Type (source/terminal), Latitude, Longitude.'
              );
              setDataPoints([]);
            } else {
              setDataPoints(parsedPoints);
            }
          } catch (err) {
            setError('Error parsing CSV file.');
            console.error(err);
          } finally {
            setLoading(false);
          }
        },
        error: (err) => {
          setError('Failed to read file.');
          console.error(err);
          setLoading(false);
        },
      });
    }
  };

  const generateTestData = (count: number) => {
    // Reset anything derived from the previous data
    setMstEdges([]);
    setCostBreakdown(null);
    setCalcError(null);
    setError(null);
    setFileName(null);

    // Generate random points within a 100 square mile area
    // 100 square miles is roughly 10 miles x 10 miles
    // 1 degree latitude ≈ 69 miles, so 10 miles ≈ 0.145 degrees,
    // 0.001 degrees ≈ 0.07 miles - more on the scale of the mini grids
    // Longitude degrees vary with latitude, but we'll use a center point
    const centerLat = 33.77728650419152; // Georgia Tech campus, Atlanta, GA
    const centerLng = -84.39617097270636;
    const latRange = 0.001; // small
    const lngRange = 0.001 / Math.cos((centerLat * Math.PI) / 180); // Adjust for longitude compression

    const points: LocationPoint[] = [];
    const maxAttempts = count * 10; // Prevent infinite loops
    let attempts = 0;

    while (points.length < count && attempts < maxAttempts) {
      // Generate coordinates with high precision

      const latOffset = (Math.random() - 0.5) * latRange * 2;
      const lngOffset = (Math.random() - 0.5) * lngRange * 2;

      // Maintain high precision by using more decimal places in calculation
      const lat = parseFloat((centerLat + latOffset).toFixed(8));
      const lng = parseFloat((centerLng + lngOffset).toFixed(8));

      // Check for duplicates (within 0.0001 degrees ≈ 30 feet)
      const isDuplicate = points.some(
        (point) =>
          Math.abs(point.lat - lat) < 0.0001 &&
          Math.abs(point.lng - lng) < 0.0001
      );

      if (!isDuplicate) {
        const type = points.length === 0 ? 'source' : 'terminal';
        const name =
          points.length === 0
            ? 'Source'
            : `Terminal ${String(points.length + 1).padStart(2, '0')}`;

        points.push({
          name: name,
          type,
          lat,
          lng,
        });
      }
      attempts++;
    }

    if (points.length < count) {
      throw new Error(
        `Could not generate ${count} unique locations within the 100 square mile area. Try a smaller number of points.`
      );
    }

    setDataPoints(points);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    const files = e.dataTransfer.files;
    if (files.length === 0) return;

    const file = files[0];
    const name = file.name.toLowerCase();

    if (
      file.type === 'text/csv' ||
      name.endsWith('.csv') ||
      name.endsWith('.kml') ||
      file.type === 'application/vnd.google-earth.kml+xml'
    ) {
      processFile(file);
    } else {
      setError('Please drop a CSV or KML file.');
    }
  };

  const handleRunSolver = async () => {
    if (dataPoints.length < 2) {
      alert('Need at least 2 points to run optimization.');
      return;
    }

    setComputingMst(true);
    setMstEdges([]);
    setCostBreakdown(null); // ← clear previous breakdown
    setCalcError(null);

    const backendUrl =
      process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000/solve';

    console.log(process.env.NEXT_PUBLIC_BACKEND_URL);

    console.log('Sending request to:', backendUrl);

    const startTime = performance.now();
    const debug = true;

    try {
      const res = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          solver: selectedSolver,
          params: {},
          points: markersRef.current.map((marker) => {
            const pos = marker.position as google.maps.LatLngLiteral; // or just as { lat: number; lng: number }

            return {
              lat: pos.lat,
              lng: pos.lng,
              name: marker.title ?? null,
            };
          }),
          costs: {
            poleCost: poleCost || 0,
            lowVoltageCostPerMeter: lowVoltageCost || 0,
            highVoltageCostPerMeter: highVoltageCost || 0,
          },
          debug: false,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || errData.error || 'Solve failed');
      }

      const endTime = performance.now();
      const durationMs = endTime - startTime;
      const durationSec = (durationMs / 1000).toFixed(2);

      console.log(
        `%c[API Request] Solve took ${durationMs.toFixed(0)} ms (${durationSec} sec)`,
        'background: #1e293b; color: #60a5fa; padding: 4px 8px; border-radius: 4px;'
      );

      const data = await res.json();

      if (debug) {
        console.log('Solver result:', data);
      }

      if (data.error) throw new Error(data.error);

      // ────────────────────────────────────────────────
      // Backend now already gives us everything we need
      // ────────────────────────────────────────────────
      const edges = data.edges || [];

      // Use pre-computed values from backend
      const {
        totalLowVoltageMeters = 0,
        totalHighVoltageMeters = 0,
        numPolesUsed = 0,
        poleCostEstimate = 0,
        lowWireCostEstimate = 0,
        highWireCostEstimate = 0,
        totalWireCostEstimate = 0,
        totalCostEstimate = 0,
        pointCount = 0,
        usedCosts, // optional – for display/debug
      } = data;

      setMstNodes(data.nodes || []);

      // Update edges (now includes lengthMeters & voltage)
      setMstEdges(
        edges.map((e: MSTEdge) => ({
          start: e.start,
          end: e.end,
          lengthMeters: e.lengthMeters ?? 0,
          voltage: e.voltage ?? 'low',
        }))
      );

      // Update cost breakdown state – directly from backend
      setCostBreakdown({
        lowVoltageMeters: totalLowVoltageMeters,
        highVoltageMeters: totalHighVoltageMeters,
        totalMeters: totalLowVoltageMeters + totalHighVoltageMeters,

        lowWireCost: lowWireCostEstimate,
        highWireCost: highWireCostEstimate,
        wireCost: totalWireCostEstimate,

        poleCount: numPolesUsed,
        poleCost: poleCostEstimate,
        pointCount: pointCount,

        grandTotal: totalCostEstimate,

        usedPoleCost: usedCosts?.poleCost,
        usedLowCostPerMeter: usedCosts?.lowVoltageCostPerMeter,
        usedHighCostPerMeter: usedCosts?.highVoltageCostPerMeter,
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to run optimization';
      setCalcError(message);
      console.error('Solver error:', err);
    } finally {
      setComputingMst(false);
    }
  };

  const generateRandomCosts = () => {
    // Generate realistic cost ranges for mini-grid components
    const poleCost = Math.round((100 + Math.random() * 200) * 100) / 100; // $100-300
    const lowVoltageCost = Math.round((1.5 + Math.random() * 3) * 100) / 100; // $1.50-4.50/m
    const highVoltageCost = Math.round((3 + Math.random() * 4) * 100) / 100; // $3-7/m

    setPoleCost(poleCost);
    setLowVoltageCost(lowVoltageCost);
    setHighVoltageCost(highVoltageCost);
  };

  const downloadKml = () => {
    if (mstNodes.length === 0 || mstEdges.length === 0) return;

    const escapeXml = (str: string) =>
      str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const formatCost = (v: number) =>
      v.toLocaleString(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      });

    const kmlStyles = `
    <Style id="source">
      <IconStyle><color>ff00cc00</color><scale>1.5</scale></IconStyle>
      <LabelStyle><color>ff00ff00</color><scale>1.1</scale></LabelStyle>
    </Style>
    <Style id="terminal">
      <IconStyle><color>ff3366ff</color><scale>1.3</scale></IconStyle>
      <LabelStyle><scale>1.0</scale></LabelStyle>
    </Style>
    <Style id="pole">
      <IconStyle><color>ffffff66</color><scale>1.1</scale></IconStyle>
      <LabelStyle><color>ffffffff</color><scale>0.85</scale></LabelStyle>
    </Style>
    <Style id="lowVoltage">
      <LineStyle><color>aa3b82f6</color><width>5</width></LineStyle>
    </Style>
    <Style id="highVoltage">
      <LineStyle><color>aa8b5cf6</color><width>7</width></LineStyle>
    </Style>
    <Style id="summary">
      <BalloonStyle>
        <text><![CDATA[<h3>$[name]</h3><p>$[description]</p>]]></text>
      </BalloonStyle>
    </Style>
  `;

    // Nodes
    let nodesKml = '';
    mstNodes.forEach((node) => {
      const styleId =
        node.type === 'source'
          ? 'source'
          : node.type === 'terminal'
            ? 'terminal'
            : 'pole';
      const displayName =
        node.type === 'pole'
          ? `Pole ${String(node.index).padStart(3, '0')}`
          : escapeXml(node.name);

      nodesKml += `
      <Placemark>
        <name>${displayName}</name>
        <styleUrl>#${styleId}</styleUrl>
        <description><![CDATA[
          <b>${escapeXml(node.name)}</b><br/>
          Type: ${node.type}<br/>
          Index: ${node.index}<br/>
          Lat,Lng: ${node.lat.toFixed(7)}, ${node.lng.toFixed(7)}
        ]]></description>
        <Point>
          <coordinates>${node.lng.toFixed(8)},${node.lat.toFixed(8)},0</coordinates>
        </Point>
      </Placemark>`;
    });

    // Edges
    let linesKml = '';
    mstEdges.forEach((edge, i) => {
      const styleId = edge.voltage === 'high' ? 'highVoltage' : 'lowVoltage';
      const lengthM = Math.round(edge.lengthMeters);
      const costPerM =
        edge.voltage === 'high' ? highVoltageCost : lowVoltageCost;
      const edgeCost = Math.round(lengthM * costPerM);

      linesKml += `
      <Placemark>
        <name>Line ${i + 1} (${edge.voltage})</name>
        <styleUrl>#${styleId}</styleUrl>
        <description><![CDATA[
          <b>Segment ${i + 1}</b><br/>
          Voltage: ${edge.voltage}<br/>
          Length: ${lengthM.toLocaleString()} m<br/>
          Est. cost: ${formatCost(edgeCost)}
        ]]></description>
        <LineString>
          <tessellate>1</tessellate>
          <coordinates>
            ${edge.start.lng.toFixed(8)},${edge.start.lat.toFixed(8)},0
            ${edge.end.lng.toFixed(8)},${edge.end.lat.toFixed(8)},0
          </coordinates>
        </LineString>
      </Placemark>`;
    });

    // Summary
    const summaryDescription = costBreakdown
      ? `
    <b>Grand Total:</b> ${formatCost(costBreakdown.grandTotal)}<br/>
    <b>Wire:</b> ${formatCost(costBreakdown.wireCost)}<br/>
      • Low: ${formatMeters(costBreakdown.lowVoltageMeters)} m → ${formatCost(costBreakdown.lowWireCost)}<br/>
      • High: ${formatMeters(costBreakdown.highVoltageMeters)} m → ${formatCost(costBreakdown.highWireCost)}<br/>
    <b>Poles:</b> ${costBreakdown.poleCount} × ${formatCost(costBreakdown.usedPoleCost ?? poleCost)}<br/>
    <br/>Nodes: ${mstNodes.length} • Segments: ${mstEdges.length}
  `
      : 'No cost data available';

    const summaryPlacemark = `
    <Placemark>
      <name>Mini-Grid Cost Summary</name>
      <styleUrl>#summary</styleUrl>
      <description><![CDATA[${summaryDescription}]]></description>
      <Point><coordinates>0,0,0</coordinates></Point>
    </Placemark>
  `;

    // Assemble final KML
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Mini-Grid • ${fileName || 'Solved Network'}</name>
    <open>1</open>

    ${kmlStyles}

    <Folder>
      <name>Nodes and Poles</name>
      <open>1</open>
      ${nodesKml}
    </Folder>

    <Folder>
      <name>Power Lines</name>
      <open>1</open>
      ${linesKml}
    </Folder>

    <Folder>
      <name>Summary</name>
      ${summaryPlacemark}
    </Folder>

  </Document>
</kml>`;

    // Download
    const blob = new Blob([kml], {
      type: 'application/vnd.google-earth.kml+xml',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `minigrid_${new Date().toISOString().slice(0, 10)}.kml`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const loadSavedRun = (run: MiniGridRun) => {
    console.log('Loading saved mini-grid:', run.id, run.name || '(no name)');

    // Log what we actually received (for debugging)
    console.log('Saved costs:', {
      poleCost: run.poleCost,
      lowVoltageCost: run.lowVoltageCost,
      highVoltageCost: run.highVoltageCost,
    });

    // Reset and load core data
    setDataPoints(run.dataPoints || []);
    setMstNodes(run.mstNodes || []);
    setMstEdges(
      (run.mstEdges || []).map((e: MSTEdge) => ({
        start: { lat: Number(e.start?.lat), lng: Number(e.start?.lng) },
        end: { lat: Number(e.end?.lat), lng: Number(e.end?.lng) },
        lengthMeters: Number(e.lengthMeters) || 0,
        voltage: e.voltage || 'low',
      }))
    );

    setPoleCost(Number(run.poleCost) || 100);
    setLowVoltageCost(Number(run.lowVoltageCost) || 10);
    setHighVoltageCost(Number(run.highVoltageCost) || 20);

    // Load cost breakdown if it exists
    setCostBreakdown(run.costBreakdown || null);

    // Restore file name / metadata
    setFileName(run.fileName || null);

    // Optional: recenter map on loaded nodes
    setTimeout(() => {
      if (map && run.mstNodes?.length > 0) {
        const bounds = new google.maps.LatLngBounds();
        run.mstNodes.forEach((p: MSTNode) =>
          bounds.extend({ lat: Number(p.lat), lng: Number(p.lng) })
        );
        map.fitBounds(bounds, { bottom: 80, left: 80, right: 80, top: 80 });
      }
    }, 300);

    alert(`Loaded: ${run.name || 'Mini-grid run'}`);
  };

  const handleDeleteRun = async (runId: string, runName?: string) => {
    if (
      !confirm(
        `Are you sure you want to delete "${runName || 'this mini-grid'}"?`
      )
    ) {
      return;
    }

    try {
      const res = await fetch(`/api/minigrids/${runId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to delete');
      }

      // Remove from local state (optimistic update)
      setSavedRuns((prev) => prev.filter((r) => r.id !== runId));

      alert('Mini-grid deleted successfully');
    } catch (err) {
      console.error('Delete error:', err);
      alert(
        'Failed to delete mini-grid: ' +
          (err instanceof Error ? err.message : 'Unknown error')
      );
    }
  };

  function SaveMiniGridButton({
    isAuthenticated,
    onSave,
    disabled,
  }: {
    isAuthenticated: boolean;
    onSave: () => void;
    disabled: boolean;
  }) {
    if (!isAuthenticated) {
      return (
        <button
          disabled
          className='flex-1 cursor-not-allowed rounded bg-zinc-700 px-10 py-4 text-center font-medium text-zinc-400 sm:flex-none'
        >
          Sign in to save Mini-Grid
        </button>
      );
    }

    return (
      <button
        onClick={onSave}
        disabled={disabled}
        className='flex-1 rounded bg-emerald-600 px-10 py-4 text-center font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none'
      >
        Save to My Mini-Grids
      </button>
    );
  }

  const handleSaveToDatabase = async () => {
    if (!session?.user?.id) {
      alert('Please sign in to save your mini-grid.');
      return;
    }

    if (mstNodes.length === 0) {
      alert('No optimization results to save yet.');
      return;
    }

    // Quick client-side check (optimistic)
    if (savedRuns.length >= 10) {
      alert(
        'You have reached the maximum of 10 saved mini-grids.\n\n' +
          'Please delete one of your existing runs before saving a new one.'
      );
      return;
    }

    const name =
      prompt('Name for this mini-grid run (optional):') ||
      `MiniGrid ${new Date().toLocaleDateString()}`;

    const payload = {
      name,
      fileName: fileName || null,
      dataPoints,
      mstNodes,
      mstEdges,
      costBreakdown,
      poleCost,
      lowVoltageCost,
      highVoltageCost,
    };

    try {
      const res = await fetch('/api/minigrids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to save mini-grid');
      }

      alert('Mini-grid saved successfully!');

      // ────────────────────────────────────────────────
      // Automatically refresh the saved runs list
      // ────────────────────────────────────────────────
      const refreshRes = await fetch('/api/minigrids');
      if (refreshRes.ok) {
        const updatedRuns = await refreshRes.json();
        setSavedRuns(updatedRuns);
        console.log('Saved runs refreshed:', updatedRuns.length, 'items');
      } else {
        console.warn(
          'Could not refresh saved runs after save',
          refreshRes.status
        );
      }
    } catch (err) {
      console.error('Save error:', err);
      alert(
        'Failed to save mini-grid: ' +
          (err instanceof Error ? err.message : 'Unknown error')
      );
    }
  };

  return (
    <div className='flex min-h-screen flex-col bg-zinc-950 text-white'>
      {/* Hero – slightly more compact */}
      <header className='relative bg-gradient-to-br from-emerald-700 via-teal-800 to-cyan-900 py-16 text-center md:py-20'>
        <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(#ffffff0f_1px,transparent_1px)] bg-[length:36px_36px] opacity-50' />
        <div className='relative mx-auto max-w-6xl px-5'>
          <div className='mb-5 inline-flex items-center gap-2.5 rounded-full border border-white/20 bg-white/10 px-5 py-1.5 text-sm font-medium tracking-wider uppercase backdrop-blur-md'>
            <span className='text-xl'>🚀</span>
            C4G – Renewvia Energy
          </div>
          <h1 className='mb-3 text-5xl font-extrabold tracking-tight sm:text-6xl md:text-7xl'>
            Mini-Grid Demo
          </h1>
          <p className='text-xl font-light text-emerald-100/90 sm:text-2xl'>
            Solar Mini-Grid Powerline Distribution Networks
          </p>
        </div>
      </header>

      <main className='mx-auto w-full max-w-7xl flex-1 py-8'>
        {/* ── 1. Input Section ──────────────────────────────────────────────── */}
        <section className='mb-10 md:mb-12'>
          <h2 className='mb-5 text-3xl font-bold text-emerald-300/95 md:text-4xl'>
            1. Define Locations
          </h2>

          <div className='grid gap-6 lg:grid-cols-15 lg:gap-8'>
            {/* Left column – controls */}
            <div className='space-y-6 lg:col-span-6'>
              {/* Upload card */}
              {/* Upload CSV or KML – compact version */}
              <div className='mb-8 rounded-lg border border-zinc-700 bg-zinc-900/50 p-5 backdrop-blur-sm'>
                <label className='mb-2.5 block text-base font-medium'>
                  Upload CSV or KML
                </label>

                {/* Examples – smaller & tighter */}
                <div className='mb-4 space-y-1.5 text-xs text-zinc-500'>
                  <p>
                    CSV example:{' '}
                    <Dialog>
                      <DialogTrigger asChild>
                        <button className='text-xs text-emerald-400 underline hover:text-emerald-300'>
                          Example
                        </button>
                      </DialogTrigger>
                      <DialogContent className='sm:max-w-lg md:max-w-xl lg:max-w-2xl'>
                        <DialogHeader>
                          <DialogTitle>CSV Sample Format</DialogTitle>
                        </DialogHeader>
                        <DialogDescription>
                          <pre className='mt-2 overflow-x-auto rounded bg-zinc-900 p-3 font-mono text-xs whitespace-pre-wrap'>
                            {`Name,Type,Latitude,Longitude
"Georgia Tech",source,33.77728650,-84.39617097
"Student Center",terminal,33.77680000,-84.39750000
"Library",terminal,33.77420000,-84.39890000
"Dorm A",terminal,33.77850000,-84.39510000
"Cafeteria",terminal,33.77790000,-84.39920000`}
                          </pre>
                          <p className='mt-3 text-xs text-zinc-400'>
                            • Header row required
                            <br />
                            • Type: source or terminal
                            <br />• ≥6 decimal places recommended
                          </p>
                        </DialogDescription>
                        <DialogFooter>
                          <DialogClose className='rounded bg-emerald-600 px-3 py-1.5 text-xs hover:bg-emerald-700'>
                            Close
                          </DialogClose>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </p>

                  <p>
                    KML example:{' '}
                    <Dialog>
                      <DialogTrigger asChild>
                        <button className='text-xs text-emerald-400 underline hover:text-emerald-300'>
                          Example
                        </button>
                      </DialogTrigger>
                      <DialogContent className='sm:max-w-lg md:max-w-xl lg:max-w-2xl'>
                        {/* your existing KML content here – same as before */}
                        <DialogHeader>
                          <DialogTitle>KML Sample Format</DialogTitle>
                        </DialogHeader>
                        <DialogDescription>
                          <pre className='mt-2 overflow-x-auto rounded bg-zinc-900 p-3 font-mono text-xs whitespace-pre-wrap'>
                            {`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>Georgia Tech</name>
      <description>Type: source</description>
      <Point>
        <coordinates>-84.39617097,33.77728650,0</coordinates>
      </Point>
    </Placemark>
    <Placemark>
      <name>Student Center</name>
      <description>Type: terminal</description>
      <Point>
        <coordinates>-84.39750000,33.77680000,0</coordinates>
      </Point>
    </Placemark>
  </Document>
</kml>`}
                          </pre>
                        </DialogDescription>
                        <DialogFooter>
                          <DialogClose className='rounded bg-emerald-600 px-3 py-1.5 text-xs hover:bg-emerald-700'>
                            Close
                          </DialogClose>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </p>
                </div>

                {/* ── Smaller drag & drop area ── */}
                <div
                  className={`relative rounded-lg border-2 border-dashed p-5 text-center transition-colors ${
                    isDragOver
                      ? 'border-emerald-400 bg-emerald-900/25'
                      : 'border-zinc-700 hover:border-zinc-600'
                  }`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                >
                  <div className='flex flex-wrap items-center justify-center gap-4'>
                    {/* Icon left */}
                    <div className='flex-shrink-0 text-3xl opacity-90'>📄</div>

                    {/* Text + button right */}
                    <div className='flex flex-col items-center gap-2'>
                      <p className='text-base font-medium text-zinc-200'>
                        {isDragOver ? 'Drop file here' : 'Drag & drop or click'}
                      </p>

                      <label className='inline-flex cursor-pointer items-center rounded bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-700 active:scale-97'>
                        Select File
                        <input
                          type='file'
                          accept='.csv,.kml'
                          onChange={handleFileUpload}
                          className='hidden'
                        />
                      </label>
                    </div>
                  </div>
                </div>

                {/* Status messages – smaller & tighter */}
                <div className='mt-3 text-center text-sm'>
                  <div className='flex flex-wrap items-center justify-center gap-x-6 gap-y-1.5'>
                    {/* Selected file */}
                    {fileName && (
                      <p className='truncate font-medium text-zinc-300'>
                        Selected:{' '}
                        <span className='text-zinc-400'>{fileName}</span>
                      </p>
                    )}

                    {/* Loaded count – shown only when successful */}
                    {dataPoints.length > 0 && !loading && (
                      <p className='font-medium text-emerald-300'>
                        Loaded {dataPoints.length} point
                        {dataPoints.length !== 1 ? 's' : ''}
                      </p>
                    )}
                  </div>

                  {/* Error or Loading – full width below if present */}
                  {error && <p className='mt-1.5 text-red-400'>{error}</p>}

                  {loading && (
                    <p className='mt-1.5 animate-pulse text-emerald-400'>
                      Processing…
                    </p>
                  )}
                </div>
              </div>

              {/* Generate Test Data – compact & reliable */}
              <div className='rounded-xl border border-zinc-800/70 bg-zinc-900/55 p-5 shadow-inner backdrop-blur-sm'>
                <h3 className='mb-3 text-lg font-semibold text-zinc-100'>
                  Generate Test Data
                </h3>
                <p className='mb-4 text-sm leading-snug text-zinc-400'>
                  Random points in ~1 mi² area – good for quick testing
                </p>

                <div className='flex flex-wrap items-center gap-4'>
                  <select
                    value={selectedCount}
                    onChange={(e) => setSelectedCount(Number(e.target.value))}
                    className='min-w-[140px] rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20'
                    disabled={loading}
                  >
                    {Array.from({ length: 91 }, (_, i) => i + 10).map((n) => (
                      <option key={n} value={n}>
                        {n} points
                      </option>
                    ))}
                  </select>

                  <button
                    onClick={async () => {
                      if (loading) return;
                      setLoading(true);
                      setError(null); // clear previous errors

                      try {
                        await generateTestData(selectedCount); // ← make sure this is async if it does any async work
                        console.log(
                          `Generated ${selectedCount} test points successfully`
                        );
                      } catch (err) {
                        const msg =
                          err instanceof Error
                            ? err.message
                            : 'Failed to generate test data';
                        setError(msg);
                        console.error('Test data generation failed:', err);
                      } finally {
                        setLoading(false);
                      }
                    }}
                    disabled={loading}
                    className={`rounded-lg px-6 py-2.5 text-sm font-medium text-white transition-all ${
                      loading
                        ? 'cursor-wait bg-blue-700/60'
                        : 'bg-blue-600 shadow-sm hover:bg-blue-700 active:scale-97'
                    } `}
                  >
                    {loading ? (
                      <span className='flex items-center gap-2'>
                        <svg
                          className='h-4 w-4 animate-spin'
                          viewBox='0 0 24 24'
                        >
                          <circle
                            className='opacity-25'
                            cx='12'
                            cy='12'
                            r='10'
                            stroke='currentColor'
                            strokeWidth='4'
                            fill='none'
                          />
                          <path
                            className='opacity-75'
                            fill='currentColor'
                            d='M4 12a8 8 0 018-8v8h8a8 8 0 01-16 0z'
                          />
                        </svg>
                        Generating…
                      </span>
                    ) : (
                      'Generate'
                    )}
                  </button>
                </div>

                {/* Error display (if any) */}
                {error && (
                  <p className='mt-3 text-center text-sm text-red-400'>
                    {error}
                  </p>
                )}
              </div>

              {/* Saved runs (only visible when logged in) */}
              {session?.user && (
                <div className='rounded-xl border border-zinc-800/70 bg-zinc-900/55 p-5 shadow-inner backdrop-blur-sm'>
                  <h3 className='mb-4 text-lg font-semibold text-zinc-100'>
                    Saved Mini-Grids ({savedRuns.length}/10)
                  </h3>

                  {loadingSaved ? (
                    <p className='py-4 text-sm text-emerald-400'>Loading…</p>
                  ) : savedRuns.length === 0 ? (
                    <p className='py-4 text-sm text-zinc-500 italic'>
                      No saved runs yet
                    </p>
                  ) : (
                    <div className='scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-zinc-900/50 -mr-2 max-h-[292px] overflow-y-auto pr-2'>
                      <div className='grid gap-4 sm:grid-cols-2'>
                        {savedRuns.map((run) => (
                          <div
                            key={run.id}
                            className='group relative cursor-pointer rounded-lg border border-zinc-800/60 bg-zinc-950/40 p-4 transition-all hover:border-emerald-700/50 hover:bg-zinc-900/60'
                            onClick={() => loadSavedRun(run)}
                          >
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteRun(run.id, run.name);
                              }}
                              className='absolute top-2 right-2 rounded-full bg-red-900/60 p-1.5 text-red-300 opacity-70 transition hover:opacity-100'
                              title='Delete run'
                            >
                              <svg
                                className='h-4 w-4'
                                fill='none'
                                stroke='currentColor'
                                viewBox='0 0 24 24'
                              >
                                <path
                                  strokeLinecap='round'
                                  strokeLinejoin='round'
                                  strokeWidth={2}
                                  d='M6 18L18 6M6 6l12 12'
                                />
                              </svg>
                            </button>

                            <h4 className='truncate font-medium text-emerald-300/90 group-hover:text-emerald-200'>
                              {run.name || 'Untitled'}
                            </h4>
                            <p className='mt-1 text-xs text-zinc-500'>
                              {run.fileName
                                ? `File: ${run.fileName}`
                                : 'Test data'}
                            </p>
                            <p className='mt-0.5 text-xs text-zinc-600'>
                              {new Date(run.createdAt).toLocaleString()} <br />
                              {run.mstNodes?.length || '?'} nodes
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {savedRuns.length >= 10 && (
                    <p className='mt-3 text-center text-xs text-amber-400'>
                      Limit reached (10). Delete one to save more.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Map – takes more space */}
            <div className='lg:col-span-9'>
              <div
                ref={mapRef}
                className='h-[55vh] w-full rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl sm:h-[65vh] lg:h-[75vh]'
              >
                Loading satellite map…
              </div>
            </div>
          </div>
        </section>

        {/* ── 2. Costs & Solver ──────────────────────────────────────── */}
        <section className='mb-10 md:mb-12'>
          <h2 className='mb-5 text-3xl font-bold text-emerald-300/95 md:text-4xl'>
            2. Costs & Solver
          </h2>

          <div className='grid gap-6 md:grid-cols-2 lg:gap-8'>
            {/* Cost inputs */}
            <div className='rounded-xl border border-zinc-800/70 bg-zinc-900/55 p-6 backdrop-blur-sm'>
              <h3 className='mb-5 text-xl font-semibold text-zinc-100'>
                Cost Parameters
              </h3>
              <div className='grid gap-5 sm:grid-cols-3'>
                {/* Pole cost */}
                <div>
                  <label className='mb-1.5 block text-sm font-medium text-zinc-300'>
                    Pole ($)
                  </label>
                  <input
                    type='number'
                    step='0.01'
                    min='0'
                    value={poleCost}
                    onChange={(e) => setPoleCost(parseFloat(e.target.value))}
                    className='w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20'
                  />
                </div>
                {/* Low voltage */}
                <div>
                  <label className='mb-1.5 block text-sm font-medium text-zinc-300'>
                    Low Voltage ($/m)
                  </label>
                  <input
                    type='number'
                    step='0.01'
                    min='0'
                    value={lowVoltageCost}
                    onChange={(e) =>
                      setLowVoltageCost(parseFloat(e.target.value))
                    }
                    className='w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20'
                  />
                </div>
                {/* High voltage */}
                <div>
                  <label className='mb-1.5 block text-sm font-medium text-zinc-300'>
                    High Voltage ($/m)
                  </label>
                  <input
                    type='number'
                    step='0.01'
                    min='0'
                    value={highVoltageCost}
                    onChange={(e) =>
                      setHighVoltageCost(parseFloat(e.target.value))
                    }
                    className='w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20'
                  />
                </div>
              </div>

              <button
                onClick={generateRandomCosts}
                className='mt-5 text-sm text-emerald-400 underline-offset-2 hover:text-emerald-300 hover:underline'
              >
                Use realistic random values
              </button>
            </div>

            {/* Run button area */}
            <div className='flex flex-col items-center justify-center rounded-xl border border-zinc-800/70 bg-zinc-900/55 p-6 text-center backdrop-blur-sm'>
              {/* Label + Select wrapper */}
              <div className='w-full'>
                <label
                  htmlFor='solver-select'
                  className='mb-2 block text-sm font-medium text-zinc-300'
                >
                  Select Solver
                </label>

                <div className='relative'>
                  <select
                    id='solver-select'
                    name='solver'
                    value={selectedSolver} // ← assume you have state for this
                    onChange={(e) => setSelectedSolver(e.target.value)}
                    className={`/* extra right padding for arrow */ w-full cursor-pointer appearance-none rounded-lg border border-zinc-700/70 bg-zinc-800/60 px-4 py-3 pr-10 text-base font-medium text-zinc-100 shadow-inner shadow-black/30 transition-all duration-200 hover:border-zinc-600/80 hover:bg-zinc-800/80 focus:border-purple-500/60 focus:ring-2 focus:ring-purple-500/50 focus:outline-none`}
                  >
                    <option value='' disabled className='text-zinc-500'>
                      Choose a solver...
                    </option>
                    {solvers.map((s) => (
                      <option
                        key={s}
                        value={s}
                        className='bg-zinc-900 text-zinc-100'
                      >
                        {s}
                      </option>
                    ))}
                  </select>

                  {/* Custom chevron arrow */}
                  <div className='pointer-events-none absolute inset-y-0 right-0 flex items-center pr-4'>
                    <svg
                      className='h-5 w-5 text-zinc-400'
                      fill='none'
                      stroke='currentColor'
                      viewBox='0 0 24 24'
                    >
                      <path
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        strokeWidth={2}
                        d='M19 9l-7 7-7-7'
                      />
                    </svg>
                  </div>
                </div>
              </div>

              <br />

              <button
                onClick={handleRunSolver}
                disabled={
                  computingMst || dataPoints.length < 2 || !selectedSolver
                } // ← added !selectedSolver check
                className={`w-full max-w-md rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 px-8 py-5 text-lg font-bold shadow-xl shadow-purple-900/40 transition-all duration-300 hover:scale-[1.02] hover:from-purple-500 hover:to-indigo-500 hover:shadow-purple-700/50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {computingMst ? 'Solving…' : 'Run Solver'}
              </button>

              <p className='mt-4 text-xs text-zinc-500'>
                Beta • Low Voltage Only • Limited to Single Power Source
              </p>

              {calcError && (
                <p className='mt-5 text-sm font-medium text-red-400'>
                  {calcError}
                </p>
              )}

              {calculationResult && (
                <div className='mt-6 w-full rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-left'>
                  <h4 className='mb-2 text-sm font-semibold text-emerald-300'>
                    Python result:
                  </h4>
                  <pre className='overflow-x-auto text-xs text-emerald-200/90'>
                    {calculationResult}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Cost breakdown (when available) */}
        {costBreakdown && (
          <section className='mb-10 md:mb-12'>
            <h2 className='mb-5 text-3xl font-bold text-emerald-300/95 md:text-4xl'>
              Estimated Costs
            </h2>
            {costBreakdown && (
              <div className='mt-8 rounded-lg border border-emerald-700/30 bg-zinc-900/70 p-6 backdrop-blur-sm'>
                <h4 className='mb-4 text-xl font-semibold text-emerald-300'>
                  Estimated Mini-Grid Costs
                </h4>

                {/* Summary Totals */}
                <div className='mb-6 grid gap-4 md:grid-cols-2'>
                  <div>
                    <p className='text-sm text-zinc-400'>Total Wire Length</p>
                    <p className='text-xl font-medium text-white'>
                      {formatMeters(costBreakdown.totalMeters) ?? '0'} m ≈{' '}
                    </p>
                  </div>

                  <div className='text-right'>
                    <p className='text-sm text-zinc-400'>
                      Grand Total Estimate
                    </p>
                    <p className='text-2xl font-bold text-emerald-300'>
                      ${formatUSD(costBreakdown.grandTotal) ?? '0.00'}
                    </p>
                  </div>
                </div>

                {/* Detailed Breakdown */}
                <div className='grid gap-6 md:grid-cols-3'>
                  {/* Poles */}
                  <div className='rounded bg-zinc-800/50 p-4'>
                    <p className='text-sm text-zinc-400'>Poles (est.)</p>
                    <p className='text-lg font-medium text-emerald-400'>
                      {costBreakdown.poleCount ?? '—'} units @ ${poleCost}
                    </p>
                    <p className='text-base font-semibold'>
                      ${formatUSD(costBreakdown.poleCost) ?? '0.00'}
                    </p>
                  </div>

                  {/* Low Voltage */}
                  <div className='rounded border-l-4 border-blue-500 bg-zinc-800/50 p-4'>
                    <p className='text-sm text-zinc-400'>Low Voltage Wire</p>
                    <p className='text-lg font-medium text-blue-300'>
                      {formatMeters(costBreakdown.lowVoltageMeters) ?? '0'} m @
                      ${lowVoltageCost}
                    </p>
                    <p className='text-base font-semibold'>
                      ${formatUSD(costBreakdown.lowWireCost) ?? '0.00'}
                    </p>
                  </div>

                  {/* High Voltage */}
                  <div className='rounded border-l-4 border-purple-500 bg-zinc-800/50 p-4'>
                    <p className='text-sm text-zinc-400'>High Voltage Wire</p>
                    <p className='text-lg font-medium text-purple-300'>
                      {formatMeters(costBreakdown.highVoltageMeters) ?? '0'} m @
                      ${highVoltageCost}
                    </p>
                    <p className='text-base font-semibold'>
                      ${formatUSD(costBreakdown.highWireCost) ?? '0.00'}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Nodes list – collapsible */}
        {dataPoints.length > 0 && (
          <section className='mb-10 md:mb-12'>
            <details className='group'>
              <summary className='flex cursor-pointer items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-6 py-4 text-lg font-semibold transition hover:bg-zinc-800/70'>
                <span>
                  Coordinates ({mstNodes.length || dataPoints.length})
                </span>
                <span className='text-xl transition-transform group-open:rotate-180'>
                  ▼
                </span>
              </summary>
              <div className='mt-3 max-h-[50vh] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 font-mono text-sm text-zinc-300'>
                {(mstNodes.length > 0 ? mstNodes : dataPoints).map(
                  (point, i) => (
                    <div key={i} className='mb-1.5'>
                      {i + 1}.{' '}
                      <span className='font-medium text-emerald-300'>
                        {point.name}
                      </span>{' '}
                      – {point.lat.toFixed(8)}, {point.lng.toFixed(8)}
                    </div>
                  )
                )}
              </div>
            </details>
          </section>
        )}

        {/* Export area */}
        {costBreakdown && mstNodes.length > 0 && (
          <section className='mb-12'>
            <div className='rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 text-center'>
              <h3 className='mb-5 text-xl font-semibold text-emerald-300'>
                Export Options
              </h3>
              <div className='mx-auto flex max-w-md flex-col justify-center gap-4 sm:flex-row'>
                {/* Download KML button */}
                <button
                  onClick={downloadKml}
                  disabled={mstNodes.length === 0 || mstEdges.length === 0}
                  className='flex-1 rounded-lg bg-purple-600/90 px-8 py-3.5 text-base font-medium transition hover:bg-purple-700 disabled:opacity-50'
                >
                  Download KML
                </button>

                {/* Save button (your component) */}
                <SaveMiniGridButton
                  isAuthenticated={!!session?.user}
                  onSave={handleSaveToDatabase}
                  disabled={
                    computingMst ||
                    mstNodes.length === 0 ||
                    savedRuns.length >= 10
                  }
                />
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className='mt-auto border-t border-zinc-800 py-8 text-center text-sm text-zinc-600'>
        © 2026 • CS 6150 Computing For Good • Renewvia Project Demo
      </footer>

      <Script
        src={`https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=marker`}
        strategy='afterInteractive'
        onLoad={initMap}
      />
    </div>
  );
}
