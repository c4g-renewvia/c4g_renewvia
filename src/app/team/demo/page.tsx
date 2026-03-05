'use client';

import React, { useEffect, useRef, useState, ChangeEvent } from 'react';
import Script from 'next/script';
import Papa from 'papaparse';
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

  // Add markers and fit bounds whenever dataPoints or map changes
  // Optimized Markers useEffect – single unified logic
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

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow uploading the same file name again
    if (!file) return;

    processFile(file);
  };

  const processFile = (file: File) => {
    // Reset anything derived from the previous CSV so the map + UI refresh cleanly
    setMstEdges([]);
    setMstNodes([]);
    setCostBreakdown(null);
    setCalcError(null);
    setError(null);
    setDataPoints([]);
    setFileName(file.name);
    setLoading(true);

    Papa.parse(file, {
      header: true, // treat first row as headers
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase(), // normalize headers
      complete: (result) => {
        try {
          const rows = result.data as Record<string, string>[];

          const parsedPoints: LocationPoint[] = rows
            .map((row) => {
              const name = row.name?.trim() || row['name'] || 'Unnamed';
              const type = row.type?.trim() || row['type'] || 'Unknown';
              const latStr = row.latitude || row.lat || '';
              const lngStr = row.longitude || row.lng || row.logitude || '';

              const lat = parseFloat(latStr);
              const lng = parseFloat(lngStr);

              if (isNaN(lat) || isNaN(lng)) return null;

              // Validate coordinate precision (require at least 6 decimal places)
              const latPrecision = (latStr.split('.')[1] || '').length;
              const lngPrecision = (lngStr.split('.')[1] || '').length;

              if (latPrecision < 6 || lngPrecision < 6) {
                console.warn(
                  `Low precision coordinates for ${name}: lat=${latStr} (${latPrecision} decimals), lng=${lngStr} (${lngPrecision} decimals)`
                );
                // Still accept but warn - could make this stricter if needed
              }

              return { name, type, lat, lng };
            })
            .filter((p): p is LocationPoint => p !== null);

          console.log('Parsed CSV:', parsedPoints);

          if (parsedPoints.length === 0) {
            setError(
              'No valid rows found. Expected columns: Name, Type, Latitude, Longitude (case-insensitive). ' +
                'Make sure lat/lng are numbers and Type is either "source" or "terminal".'
            );
            setDataPoints([]); // ensure old markers stay cleared
          } else {
            setDataPoints(parsedPoints);
          }
        } catch (err) {
          setError('Error parsing CSV. Please check file format.');
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
            : `Destination ${String(points.length + 1).padStart(2, '0')}`;

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
    if (files.length > 0) {
      const file = files[0];
      if (
        file.type === 'text/csv' ||
        file.name.toLowerCase().endsWith('.csv')
      ) {
        // Process the file directly instead of creating a synthetic event
        processFile(file);
      } else {
        setError('Please drop a CSV file.');
      }
    }
  };

  const handleRunOptimization = async () => {
    if (dataPoints.length < 2) {
      alert('Need at least 2 points to run optimization.');
      return;
    }

    setComputingMst(true);
    setMstEdges([]);
    setCostBreakdown(null); // ← clear previous breakdown
    setCalcError(null);

    const backendUrl =
      process.env.NEXT_PUBLIC_BACKEND_URL ||
      'http://localhost:8000/optimize/v1';

    const startTime = performance.now();
    const debug = true;

    try {
      const res = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
        throw new Error(
          errData.detail || errData.error || 'Optimization failed'
        );
      }

      const endTime = performance.now();
      const durationMs = endTime - startTime;
      const durationSec = (durationMs / 1000).toFixed(2);

      console.log(
        `%c[API Request] Optimization took ${durationMs.toFixed(0)} ms (${durationSec} sec)`,
        'background: #1e293b; color: #60a5fa; padding: 4px 8px; border-radius: 4px;'
      );

      const data = await res.json();

      if (debug) {
        console.log('Optimization result:', data);
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
      console.error('Optimization error:', err);
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
    <name>Mini-Grid • ${fileName || 'Optimized Network'}</name>
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
          Sign in to save
        </button>
      );
    }

    return (
      <button
        onClick={onSave}
        disabled={disabled}
        className='flex-1 rounded bg-emerald-600 px-10 py-4 text-center font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none'
      >
        Save to My Maps
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
    <div className='min-h-screen overflow-hidden bg-zinc-950 text-white'>
      {/* Hero Header – unchanged */}
      <header className='relative bg-linear-to-br from-emerald-600 via-teal-700 to-cyan-700 py-28 text-center md:py-32'>
        <div className='absolute inset-0 bg-[radial-gradient(#ffffff10_1px,transparent_1px)] bg-size-[40px_40px]' />
        <div className='relative mx-auto max-w-6xl px-6'>
          <div className='mb-8 inline-flex items-center gap-3 rounded-full border border-white/20 bg-white/10 px-6 py-2 backdrop-blur-md'>
            <span className='text-2xl'>🚀</span>
            <span className='text-sm font-medium tracking-[4px] uppercase'>
              C4G - Renewvia Energy Project
            </span>
          </div>

          <h1 className='mb-6 text-6xl font-bold tracking-tighter md:text-7xl lg:text-8xl'>
            Project Demo
          </h1>
          <p className='mb-10 text-3xl font-light text-emerald-100 md:text-4xl lg:text-5xl'>
            Solar Mini-Grid Powerline Distribution Networks
          </p>
        </div>
      </header>

      <main className='mx-auto max-w-7xl px-6 py-12'>
        <h2 className='mb-6 text-4xl font-bold'>
          Mini-Grid Optimization Coordinate and Edges Generation
        </h2>

        {/* Map Input – Combined Upload / Test Data / Saved Runs Section */}
        <div className='mb-12 rounded-xl border border-zinc-600 bg-zinc-900/40 p-8 shadow-xl backdrop-blur-md'>
          <h2 className='mb-8 text-3xl font-bold text-emerald-300'>
            Map Input
          </h2>

          {/* Upload CSV */}
          <div className='mb-10'>
            <label className='mb-3 block text-xl font-medium text-white'>
              Upload CSV with your locations
            </label>
            <p className='mb-4 text-sm text-zinc-400'>
              Expected columns: <code className='text-emerald-300'>Name</code>,{' '}
              <code className='text-emerald-300'>Type</code>,{' '}
              <code className='text-emerald-300'>Latitude</code>,{' '}
              <code className='text-emerald-300'>Longitude</code>{' '}
              (case-insensitive)
            </p>
            <p className='mb-6 text-sm text-zinc-500'>
              Example:
              <br />
              <code className='mt-1 block text-blue-300'>
                Georgia Tech, source, 33.77728650, -84.39617097
                <br />
                Building 1, terminal, 33.77798650, -84.39613097
              </code>
            </p>

            <div
              className={`relative rounded-lg border-2 border-dashed p-10 text-center transition-all duration-200 ${
                isDragOver
                  ? 'scale-[1.01] border-emerald-400 bg-emerald-900/25'
                  : 'border-zinc-600 hover:border-zinc-500 hover:bg-zinc-950/30'
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className='space-y-5'>
                <div className='text-5xl'>📄</div>
                <div>
                  <p className='mb-3 text-xl font-medium text-zinc-200'>
                    {isDragOver
                      ? 'Drop your CSV file here'
                      : 'Drag & drop your CSV file here'}
                  </p>
                  <p className='text-sm text-zinc-500'>or</p>
                </div>
                <label className='inline-block cursor-pointer rounded-lg bg-emerald-600 px-8 py-4 font-semibold text-white shadow-md transition hover:bg-emerald-700 active:scale-95'>
                  Choose CSV File
                  <input
                    type='file'
                    accept='.csv'
                    onChange={handleFileUpload}
                    className='hidden'
                  />
                </label>
              </div>
            </div>

            <div className='mt-5 flex flex-col gap-2 text-center'>
              {fileName && (
                <p className='text-sm text-zinc-300'>
                  Selected: <span className='font-medium'>{fileName}</span>
                </p>
              )}
              {error && <p className='text-red-400'>{error}</p>}
              {loading && (
                <p className='text-emerald-400'>Processing file...</p>
              )}
              {dataPoints.length > 0 && !loading && (
                <p className='font-medium text-emerald-300'>
                  Loaded {dataPoints.length} valid location
                  {dataPoints.length !== 1 ? 's' : ''}.
                </p>
              )}
            </div>
          </div>

          {/* Divider */}
          <div className='my-10 h-px bg-gradient-to-r from-transparent via-zinc-700 to-transparent' />

          {/* Generate Test Data */}
          <div className='mb-10'>
            <label className='mb-3 block text-xl font-medium text-white'>
              Or Generate Random Test Data
            </label>
            <p className='mb-5 text-sm text-zinc-400'>
              Create random location points within ~1 square mile area – great
              for quick testing or demos.
            </p>

            <div className='flex flex-wrap items-center gap-5'>
              <select
                value={selectedCount}
                onChange={(e) => setSelectedCount(parseInt(e.target.value))}
                className='min-w-[140px] rounded-lg border border-zinc-600 bg-zinc-800 px-5 py-3 text-white focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/30 focus:outline-none'
              >
                {Array.from({ length: 91 }, (_, i) => i + 10).map((num) => (
                  <option key={num} value={num}>
                    {num} points
                  </option>
                ))}
              </select>

              <button
                onClick={() => {
                  try {
                    generateTestData(selectedCount);
                  } catch (err) {
                    setError(
                      err instanceof Error
                        ? err.message
                        : 'Failed to generate test data'
                    );
                  }
                }}
                className='rounded-lg bg-blue-600 px-8 py-3 font-semibold text-white shadow-md transition hover:bg-blue-700 active:scale-95 disabled:opacity-50'
                disabled={loading}
              >
                Generate Test Data
              </button>
            </div>
          </div>

          {/* Divider */}
          {session?.user && (
            <>
              <div className='my-10 h-px bg-gradient-to-r from-transparent via-zinc-700 to-transparent' />

              {/* Saved Mini-Grids */}
              <div>
                <h3 className='mb-5 text-2xl font-semibold text-emerald-200'>
                  Or Load Saved Mini-Grids
                </h3>

                {loadingSaved ? (
                  <p className='text-emerald-400'>Loading your saved runs...</p>
                ) : savedRuns.length === 0 ? (
                  <p className='text-zinc-400 italic'>
                    You haven&#39;t saved any mini-grid runs yet.
                  </p>
                ) : (
                  <div className='grid gap-5 sm:grid-cols-2 lg:grid-cols-3'>
                    {savedRuns.map((run) => (
                      <div
                        key={run.id}
                        className='group relative cursor-pointer rounded-lg border border-zinc-700 bg-zinc-900/70 p-5 transition-all hover:border-emerald-600/60 hover:bg-zinc-900 hover:shadow-lg'
                      >
                        {/* Delete button – top right corner */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation(); // prevent card click / load
                            handleDeleteRun(run.id, run.name);
                          }}
                          className='absolute top-3 right-3 z-10 rounded-full bg-red-900/70 p-2 text-red-300 opacity-70 transition hover:bg-red-800 hover:opacity-100'
                          title='Delete this mini-grid'
                        >
                          <svg
                            xmlns='http://www.w3.org/2000/svg'
                            className='h-5 w-5'
                            fill='none'
                            viewBox='0 0 24 24'
                            stroke='currentColor'
                          >
                            <path
                              strokeLinecap='round'
                              strokeLinejoin='round'
                              strokeWidth={2}
                              d='M6 18L18 6M6 6l12 12'
                            />
                          </svg>
                        </button>

                        <div onClick={() => loadSavedRun(run)}>
                          <h4 className='mb-2 font-semibold text-emerald-300 group-hover:text-emerald-200'>
                            {run.name || 'Untitled Run'}
                          </h4>
                          <p className='mb-2 text-sm text-zinc-400'>
                            {run.fileName
                              ? `From: ${run.fileName}`
                              : 'Test data / manual input'}
                          </p>
                          <div className='text-xs text-zinc-500'>
                            {new Date(run.createdAt).toLocaleString()} •{' '}
                            {run.mstNodes?.length || '?'} nodes
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Cost Inputs & Calculate Section */}
        <div className='mt-12 rounded-lg border border-zinc-700 bg-zinc-900/50 p-8 backdrop-blur-sm'>
          <h3 className='mb-6 text-3xl font-bold'>Input Variables</h3>
          <p className='mb-6 text-zinc-300'>
            Enter approximate costs per unit. The algorithm will process these
            values as hyperparameters and calculate locations for Poles, Wire,
            and transformers.
          </p>
          <p className='mb-4 text-sm text-zinc-500'>
            Example: Pole $175.00, Low Voltage $2.75/m, High Voltage $4.25/m
          </p>

          <div className='grid gap-6 md:grid-cols-3'>
            <div>
              <label className='mb-2 block text-sm font-medium'>
                Cost per Pole ($)
              </label>
              <input
                type='number'
                step='0.01'
                min='0'
                value={poleCost}
                onChange={(e) => setPoleCost(parseFloat(e.target.value))}
                className='w-full rounded border border-zinc-600 bg-zinc-800 px-4 py-2 text-white focus:border-emerald-500 focus:outline-none'
              />
            </div>

            <div>
              <label className='mb-2 block text-sm font-medium'>
                Low Voltage Wire ($/meter)
              </label>
              <input
                type='number'
                step='0.01'
                min='0'
                value={lowVoltageCost}
                onChange={(e) => setLowVoltageCost(parseFloat(e.target.value))}
                className='w-full rounded border border-zinc-600 bg-zinc-800 px-4 py-2 text-white focus:border-emerald-500 focus:outline-none'
              />
            </div>

            <div>
              <label className='mb-2 block text-sm font-medium'>
                High Voltage Wire ($/meter)
              </label>
              <input
                type='number'
                step='0.01'
                min='0'
                value={highVoltageCost}
                onChange={(e) => setHighVoltageCost(parseFloat(e.target.value))}
                className='w-full rounded border border-zinc-600 bg-zinc-800 px-4 py-2 text-white focus:border-emerald-500 focus:outline-none'
              />
            </div>
          </div>

          <div className='mt-6 flex gap-4'>
            <button
              onClick={generateRandomCosts}
              className='rounded bg-zinc-700 px-6 py-2 text-sm font-medium text-white hover:bg-zinc-600'
            >
              Generate Random Costs
            </button>
          </div>
        </div>

        <div className='mt-12 rounded-lg border border-zinc-700 bg-zinc-900/50 p-8 backdrop-blur-sm'>
          <div className='flex justify-center'>
            <button
              onClick={handleRunOptimization}
              disabled={computingMst || dataPoints.length < 2}
              className='rounded bg-purple-600 px-10 py-5 text-lg font-bold text-white shadow-lg shadow-purple-900/30 transition-all hover:bg-purple-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50'
            >
              {computingMst
                ? 'Running Optimization...'
                : 'Run Optimization Algorithm'}
            </button>
          </div>

          <p className='mt-6 text-center text-sm text-zinc-500'>
            Note: In Development - In beta until April 26th 2026. Only Low
            Voltage
          </p>

          {calculationResult && (
            <div className='mt-8 rounded border border-zinc-700 bg-zinc-800/80 p-6'>
              <h4 className='mb-4 text-xl font-semibold text-emerald-300'>
                Result from Python Script:
              </h4>
              <pre className='max-h-96 overflow-auto rounded bg-zinc-950/50 p-4 text-sm whitespace-pre-wrap text-emerald-200'>
                {calculationResult}
              </pre>
            </div>
          )}

          {calcError && (
            <p className='mt-6 text-center font-medium text-red-400'>
              {calcError}
            </p>
          )}
        </div>

        {/* Map container */}
        <div
          ref={mapRef}
          className='mt-8 h-[70vh] w-full rounded-xl border border-zinc-700 shadow-2xl'
        >
          Loading satellite map...
        </div>
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
                <p className='text-sm text-zinc-400'>Grand Total Estimate</p>
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
                  {formatMeters(costBreakdown.lowVoltageMeters) ?? '0'} m @ $
                  {lowVoltageCost}
                </p>
                <p className='text-base font-semibold'>
                  ${formatUSD(costBreakdown.lowWireCost) ?? '0.00'}
                </p>
              </div>

              {/* High Voltage */}
              <div className='rounded border-l-4 border-purple-500 bg-zinc-800/50 p-4'>
                <p className='text-sm text-zinc-400'>High Voltage Wire</p>
                <p className='text-lg font-medium text-purple-300'>
                  {formatMeters(costBreakdown.highVoltageMeters) ?? '0'} m @ $
                  {highVoltageCost}
                </p>
                <p className='text-base font-semibold'>
                  ${formatUSD(costBreakdown.highWireCost) ?? '0.00'}
                </p>
              </div>
            </div>
          </div>
        )}
        {/* Script loader */}
        <Script
          src={`https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=marker`}
          strategy='afterInteractive'
          onLoad={initMap}
        />
      </main>

      {/* Nodes List – Collapsible */}
      {dataPoints.length > 0 && (
        <section className='mx-auto max-w-7xl px-6 py-12'>
          <details className='group'>
            <summary className='flex cursor-pointer items-center justify-between rounded-lg border border-zinc-700 bg-zinc-900/70 px-6 py-4 text-xl font-bold text-white transition hover:bg-zinc-800/70'>
              <h3>
                Source, Destination, and Generated Pole Coordinates (
                {mstNodes.length || dataPoints.length})
              </h3>
              <span className='text-2xl font-light transition-transform group-open:rotate-180'>
                ▼
              </span>
            </summary>

            <div className='mt-4 rounded-lg border border-zinc-700 bg-zinc-900/50 p-6 backdrop-blur-sm'>
              <div className='max-h-[60vh] overflow-y-auto font-mono text-sm text-zinc-300'>
                {(mstNodes.length > 0 ? mstNodes : dataPoints).map(
                  (point, index) => (
                    <div key={index} className='mb-1.5 leading-relaxed'>
                      {index + 1}.{' '}
                      <span className='font-semibold text-emerald-300'>
                        {point.name}
                      </span>
                      {' – Lat: '}
                      <span className='text-blue-300'>
                        {point.lat.toFixed(8)}
                      </span>
                      ,{' Lng: '}
                      <span className='text-blue-300'>
                        {point.lng.toFixed(8)}
                      </span>
                    </div>
                  )
                )}
              </div>

              {/* Optional footer info */}
              {mstNodes.length > 0 && (
                <p className='mt-4 text-center text-xs text-zinc-500'>
                  Showing optimized nodes (source + terminals + poles). Scroll
                  for full list.
                </p>
              )}
            </div>
          </details>
        </section>
      )}

      {costBreakdown && mstNodes.length > 0 && (
        <section className='mx-auto max-w-7xl px-6 py-12'>
          <div className='mx-auto mt-8 max-w-2xl rounded-lg border border-zinc-700 bg-zinc-900/50 p-6 backdrop-blur-sm'>
            <h4 className='mb-5 text-center text-xl font-semibold text-emerald-300'>
              Export Results
            </h4>

            <div className='flex flex-col justify-center gap-5 sm:flex-row'>
              <button
                onClick={downloadKml}
                className='flex-1 rounded bg-purple-600 px-10 py-4 text-center font-medium text-white transition hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none'
                disabled={mstNodes.length === 0 || mstEdges.length === 0}
              >
                Download KML
              </button>

              <SaveMiniGridButton
                isAuthenticated={!!session?.user} // you'll add useSession below
                onSave={handleSaveToDatabase}
                disabled={computingMst || mstNodes.length === 0}
              />
            </div>
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className='border-t border-zinc-800 py-12 text-center text-sm text-zinc-500'>
        <p>
          © 2026 • CS 6150 Computing For Good • Renewvia Project • Demo Page
        </p>
      </footer>
    </div>
  );
}
