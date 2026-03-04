# backend/mst.py
from scipy.spatial.distance import cdist

from .candidate_generation import *
from .build_graph import *


def compute_mst(request: OptimizationRequest) -> Dict[str, Any]:
    """
    Compute a realistic power distribution network using MST with intermediate poles.
    Returns serialized dict ready for JSON response.
    """
    # ─── 1. Parse input ─────────────────────────────────────────────────────
    coords, terminal_indices, source_idx, original_names, costs = parse_input(request)
    debug = request.debug

    # ─── 2. Generate candidates ─────────────────────────────────────────────
    candidates = generate_fermat_candidates(coords, max_candidates=100)
    # candidates = filter_candidates_by_buildings(candidates, coords)  # optional

    # ─── 3. Create unified list of Node objects ─────────────────────────────
    nodes: List[Node] = []

    # Original points (source + terminals)
    for i, (lat, lng) in enumerate(coords):
        node_type = "source" if i == source_idx else "terminal"
        name = original_names[i] if i < len(original_names) else f"Point {i}"
        nodes.append(Node(
            index=i,
            lat=float(lat),
            lng=float(lng),
            type=node_type,
            name=name,
            is_candidate=False,
            used=True,          # originals are always kept
        ))

    pole_start_idx = len(coords)

    # Candidate poles
    for i, (lat, lng) in enumerate(candidates, start=pole_start_idx):
        nodes.append(Node(
            index=i,
            lat=float(lat),
            lng=float(lng),
            type="pole",
            name=None,          # assigned later if used
            is_candidate=True,
            used=False,
        ))

    # ─── 4. Distance matrix ─────────────────────────────────────────────────
    all_coords = np.array([n.coord_tuple for n in nodes])
    dist_matrix = cdist(
        all_coords,
        all_coords,
        metric=lambda u, v: haversine_meters(u[0], u[1], v[0], v[1])
    )

    pole_indices = [n.index for n in nodes if n.type == "pole"]

    # ─── 5. Build graph & compute arborescence ──────────────────────────────
    DG = build_directed_graph_for_arborescence(
        source_idx=source_idx,
        terminal_indices=terminal_indices,
        pole_indices=pole_indices,
        dist_matrix=dist_matrix,
        costs=costs,
    )

    arbo = nx.minimum_spanning_arborescence(DG, attr="weight", preserve_attrs=True, default=1e18)

    # ─── 6. Prune useless dead-end poles ────────────────────────────────────
    mst = prune_dead_end_pole_branches(arbo, pole_indices, terminal_indices)

    mst, nodes = fragment_long_edges_with_coords(
        mst=mst,
        nodes=nodes,  # your unified Node list from earlier
        max_length_m=30.0,
        min_segment_length=5.0,
    )

    # ─── 7. Mark used nodes & auto-name poles ───────────────────────────────
    used_indices = {u for u, v in mst.edges()} | {v for u, v in mst.edges()}

    pole_counter = 1
    for node in nodes:
        if node.index in used_indices:
            node.used = True
            if node.type == "pole" and node.name is None:
                node.name = f"Pole {pole_counter}"
                pole_counter += 1
        else:
            node.used = False

    used_nodes = [n for n in nodes if n.used]

    # ─── 8. Build output edges ──────────────────────────────────────────────
    edges: List[OutputEdge] = []
    total_low_m = 0.0
    total_high_m = 0.0

    for u, v, data in mst.edges(data=True):
        length_m = data.get("length", 0.0)
        voltage = data.get("voltage", "unknown")

        start_node = next(n for n in nodes if n.index == u)
        end_node   = next(n for n in nodes if n.index == v)

        edges.append(OutputEdge(
            start={
                "lat": start_node.lat,
                "lng": start_node.lng,
                "name": start_node.name or f"Node {start_node.index}",
                "type": start_node.type,
            },
            end={
                "lat": end_node.lat,
                "lng": end_node.lng,
                "name": end_node.name or f"Node {end_node.index}",
                "type": end_node.type,
            },
            lengthMeters=round(length_m, 2),
            voltage=voltage,  # type: ignore  (pydantic will validate)
        ))

        if voltage == "low":
            total_low_m += length_m
        elif voltage == "high":
            total_high_m += length_m

    # ─── 9. Cost estimation ─────────────────────────────────────────────────
    pole_cost     = float(costs.get("poleCost", 1500.0))
    low_cost_m    = float(costs.get("lowVoltageCostPerMeter", 8.0))
    high_cost_m   = float(costs.get("highVoltageCostPerMeter", 25.0))

    num_poles_used = sum(1 for n in used_nodes if n.type == "pole")

    pole_cost_est   = num_poles_used * pole_cost
    low_wire_est    = total_low_m * low_cost_m
    high_wire_est   = total_high_m * high_cost_m
    total_wire_est  = low_wire_est + high_wire_est
    total_cost_est  = pole_cost_est + total_wire_est

    # ─── 10. Prepare output nodes (serializable) ────────────────────────────
    if debug:
        output_nodes = [
            {
                "index": n.index,
                "lat": n.lat,
                "lng": n.lng,
                "name": n.name or f"Candidate {n.index}",
                "type": n.type,
                "used": n.used,
            }
            for n in nodes
        ]
    else:
        output_nodes = [
            {
                "index": n.index,
                "lat": n.lat,
                "lng": n.lng,
                "name": n.name,
                "type": n.type,
            }
            for n in used_nodes
        ]

    # ─── 11. Build & return validated result ────────────────────────────────
    result = OptimizationResult(
        edges=edges,
        nodes=output_nodes,
        totalLowVoltageMeters=round(total_low_m, 2),
        totalHighVoltageMeters=round(total_high_m, 2),
        numPolesUsed=num_poles_used,
        poleCostEstimate=round(pole_cost_est, 2),
        lowWireCostEstimate=round(low_wire_est, 2),
        highWireCostEstimate=round(high_wire_est, 2),
        totalWireCostEstimate=round(total_wire_est, 2),
        totalCostEstimate=round(total_cost_est, 2),
        debug={
            "sourceIndex": source_idx,
            "sourceName": next(n.name for n in nodes if n.index == source_idx),
            "originalPoints": len(coords),
            "candidatesGenerated": len(candidates),
            "candidatesUsed": num_poles_used,
        } if debug else None
    )

    return result.model_dump(by_alias=False, exclude_none=True)