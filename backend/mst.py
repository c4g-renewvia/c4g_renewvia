# backend/mst.py
from typing import List, Dict, Union, Any
import numpy as np
import networkx as nx
from itertools import combinations
from pydantic import BaseModel

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
    Compute Minimum Spanning Tree (MST) from list of points and costs.
    
    Args:
        request: OptimizationRequest object from FastAPI
        
    Returns:
        Dict with MST edges, lengths, costs, and metadata
        
    Raises:
        ValueError: If fewer than 2 valid points
        RuntimeError: On computation failure
    """
    # Extract points and costs
    points = request.points
    costs = request.costs

    # Build cleaned coordinate list
    coords = []
    for p in points:
        lat = p.get("lat")
        lng = p.get("lng")
        if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
            coords.append({"Latitude": float(lat), "Longitude": float(lng)})

    if len(coords) < 2:
        raise ValueError("Need at least 2 valid points with numeric lat/lng")

    # Convert to DataFrame for consistency with your original code
    import pandas as pd
    coords_df = pd.DataFrame(coords)

    received_costs = {
        "poleCost": float(costs.get("poleCost", 0)),
        "lowVoltageCostPerMeter": float(costs.get("lowVoltageCostPerMeter", 0)),
        "highVoltageCostPerMeter": float(costs.get("highVoltageCostPerMeter", 0)),
    }

    # Build graph
    G = nx.Graph()
    for i, row in coords_df.iterrows():
        G.add_node(i, pos=(row['Longitude'], row['Latitude']))

    for (i, j) in combinations(coords_df.index, 2):
        lat1, lon1 = coords_df.loc[i, ['Latitude', 'Longitude']]
        lat2, lon2 = coords_df.loc[j, ['Latitude', 'Longitude']]
        length = np.sqrt((lat2 - lat1)**2 + (lon2 - lon1)**2)

        # Current logic: all edges use low-voltage cost for weight
        # You can make this smarter later (e.g. based on distance, name, etc.)
        weight = length * received_costs['lowVoltageCostPerMeter']

        G.add_edge(i, j, weight=weight, length=length, voltage="low")

    # Compute MST
    mst = nx.minimum_spanning_tree(G, algorithm='kruskal')

    # Build result
    edges = []
    total_weight = 0.0
    low_voltage_length = 0.0
    high_voltage_length = 0.0

    for u, v, d in mst.edges(data=True):
        p1 = coords_df.loc[u]
        p2 = coords_df.loc[v]
        edges.append({
            "start": {"lat": float(p1['Latitude']), "lng": float(p1['Longitude'])},
            "end": {"lat": float(p2['Latitude']), "lng": float(p2['Longitude'])},
            "weight": float(d['weight']),
            "length": float(d['length']),
            "voltage": d['voltage'],
        })
        if d['voltage'] == 'low':
            low_voltage_length += d['length']
        else:
            high_voltage_length += d['length']
        total_weight += d['weight']

    return {
        "edges": edges,
        "total_weight": float(total_weight),
        "low_voltage_length": float(low_voltage_length),
        "high_voltage_length": float(high_voltage_length),
        "point_count": len(coords),
        "receivedCosts": received_costs,
    }