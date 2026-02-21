# backend/mst.py
from typing import List, Dict, Union, Any
import networkx as nx
from pydantic import BaseModel
import math


def haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate great-circle distance between two points in meters (haversine formula)."""
    R = 6371000.0  # Earth mean radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)

    a = math.sin(dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


class OptimizationRequest(BaseModel):
    """
    Schema matching the exact payload from Next.js frontend.
    - points: list of dicts with lat/lng (float) and optional name (str)
    - costs: dict with poleCost, lowVoltageCostPerMeter, highVoltageCostPerMeter (float)
    """
    points: List[Dict[str, Union[float, str, None]]]
    costs: Dict[str, float]


def compute_mst(request: OptimizationRequest) -> Dict[str, Any]:
    """
    Compute Minimum Spanning Tree (MST) from list of points and return
    realistic length-based costs separated by voltage.
    """
    points = request.points
    costs = request.costs

    # ─── Clean & validate input points ──────────────────────────────────────
    coords = []
    for p in points:
        lat = p.get("lat")
        lng = p.get("lng")
        if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
            coords.append({"lat": float(lat), "lng": float(lng)})

    if len(coords) < 2:
        raise ValueError("Need at least 2 valid points with numeric lat/lng")

    # Extract cost parameters (with safe defaults)
    pole_cost = float(costs.get("poleCost", 0))
    low_voltage_cost_m = float(costs.get("lowVoltageCostPerMeter", 0))
    high_voltage_cost_m = float(costs.get("highVoltageCostPerMeter", 0))

    # ─── Build complete graph ───────────────────────────────────────────────
    G = nx.Graph()

    for i, pt in enumerate(coords):
        G.add_node(i, pos=(pt["lng"], pt["lat"]))

    for i in range(len(coords)):
        for j in range(i + 1, len(coords)):
            lat1, lon1 = coords[i]["lat"], coords[i]["lng"]
            lat2, lon2 = coords[j]["lat"], coords[j]["lng"]
            length_m = haversine_meters(lat1, lon1, lat2, lon2)

            # For MST weight we still use low-voltage cost (common simplification)
            # You can experiment with more sophisticated weighting later
            weight = length_m * low_voltage_cost_m

            G.add_edge(i, j, weight=weight, length=length_m, voltage="low")

    # ─── Compute MST ────────────────────────────────────────────────────────
    mst = nx.minimum_spanning_tree(G, algorithm="kruskal")

    # ─── Collect MST edges + accumulate real lengths by voltage ─────────────
    edges = []
    total_low_voltage_m = 0.0
    total_high_voltage_m = 0.0

    for u, v, data in mst.edges(data=True):
        p1 = coords[u]
        p2 = coords[v]
        length_m = data["length"]
        voltage = data["voltage"]  # currently always "low"

        edges.append({
            "start": {"lat": p1["lat"], "lng": p1["lng"]},
            "end":   {"lat": p2["lat"], "lng": p2["lng"]},
            "lengthMeters": round(length_m, 2),
            "voltage": voltage,
        })

        if voltage == "low":
            total_low_voltage_m += length_m
        else:
            total_high_voltage_m += length_m

    # ─── Cost estimation (moved from frontend) ──────────────────────────────
    num_poles_estimate = len(edges) + 1 if edges else len(coords)  # rough heuristic
    pole_cost_est = num_poles_estimate * pole_cost

    low_wire_cost_est = total_low_voltage_m * low_voltage_cost_m
    high_wire_cost_est = total_high_voltage_m * high_voltage_cost_m
    total_wire_cost_est = low_wire_cost_est + high_wire_cost_est

    total_cost_est = pole_cost_est + total_wire_cost_est

    # ─── Return enriched result ─────────────────────────────────────────────
    return {
        "edges": edges,
        "totalLowVoltageMeters": round(total_low_voltage_m, 2),
        "totalHighVoltageMeters": round(total_high_voltage_m, 2),
        "numPolesEstimate": num_poles_estimate,
        "poleCostEstimate": round(pole_cost_est, 2),
        "lowWireCostEstimate": round(low_wire_cost_est, 2),
        "highWireCostEstimate": round(high_wire_cost_est, 2),
        "totalWireCostEstimate": round(total_wire_cost_est, 2),
        "totalCostEstimate": round(total_cost_est, 2),
        "pointCount": len(coords),
        "usedCosts": {
            "poleCost": pole_cost,
            "lowVoltageCostPerMeter": low_voltage_cost_m,
            "highVoltageCostPerMeter": high_voltage_cost_m,
        },
    }