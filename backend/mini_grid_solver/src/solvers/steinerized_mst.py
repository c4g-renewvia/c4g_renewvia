# optimizers/steinerized_mst.py

from typing import Tuple

import networkx as nx

from .base_mini_grid_solver import BaseMiniGridSolver
from .registry import register_solver
from ..utils.models import SolverRequest


@register_solver
class SteinerizedMSTSolver(BaseMiniGridSolver):
    """
    Mini-grid power network optimizer using the Steinerized Minimum Spanning Tree heuristic.

    This solver provides a practical, fast approximation for laying out a mini-grid
    under a strict maximum edge length constraint (e.g., 30 meters per cable segment
    due to voltage drop, safety, or installation rules).

    Algorithm overview:
    1. Compute the Euclidean (haversine) Minimum Spanning Tree (MST) on the original
       set of points: 1 power source + N buildings/terminals.
    2. For every MST edge longer than max_edge_length, insert evenly spaced intermediate
       "pole" nodes along the great-circle path to ensure no single cable segment exceeds
       the allowed length.
    3. The resulting structure is a tree rooted at the power source, connecting all
       terminals with only short edges.

    Strengths:
    - Guarantees all edges ≤ max_edge_length
    - Fast (O(n² log n) worst-case, but practical for hundreds of points)
    - Simple to implement and debug
    - Provides a good baseline (often within 1.5–2× optimal number of extra poles in practice)

    Limitations:
    - Does not attempt to add "true" Steiner points at optimal 120° junctions
    - Pole placement is purely linear along MST edges (no merging or optimization)
    - Uses linear interpolation in lat/lon for intermediates (sufficient for short segments)

    Typical use case: Rural mini-grids where pole installation cost dominates and
    maximum span is constrained (e.g., 30 m due to low-voltage cable limits).
    """

    def __init__(self, request: SolverRequest, max_edge_length: float = 30.0):
        """
        Initialize the solver with the input request and edge length constraint.

        Args:
            request: SolverRequest containing points (lat/lng), solver, etc.
            max_edge_length: Maximum allowed length (meters) for any single cable segment.
                             Defaults to 30.0 meters.
        """
        super().__init__(request)
        self.max_edge_length = max_edge_length

    def _solve(self, input_tuple) -> Tuple[nx.Graph]:
        """
        Execute the full Steinerized MST algorithm and produce a SolverResult.

        Returns:
            graph, nodes, coords: The resulting graph structure,
                list of nodes (including any new poles),
                the actual coordinates themselves
        """
        # ─── 1. Parse input once and cache results ──────────────────────────────
        nodes, coords, source_idx, terminal_indices, names, costs = input_tuple

        # ─── 2. Compute full distance matrix using vectorized haversine ─────────
        # This avoids O(n²) scalar calls and is much faster for moderate n
        dist_matrix = self.compute_distance_matrix(coords)

        n = len(coords)

        G = nx.complete_graph(n)
        for node in nodes:
            G.nodes[node.index]["name"] = node.name
            G.nodes[node.index]["type"] = node.type
            G.nodes[node.index]["lat"] = node.lat
            G.nodes[node.index]["lng"] = node.lng
            G.nodes[node.index]["used"] = node.used

        for i in range(n):
            for j in range(i + 1, n):
                d = dist_matrix[i, j]
                weight = d * costs["lowVoltageCostPerMeter"]
                G.edges[i, j]["weight"] = weight
                G.edges[i, j]["length"] = d
                G.edges[i, j]["voltage"] = "low"
        mst = nx.minimum_spanning_tree(G, weight="weight")

        # ─── 6. Process each MST edge: steinerize if necessary ──────────────────
        new_node_counter = n  # start numbering new poles from original n

        for u, v, data in list(mst.edges(data=True)):  # use list() because we modify graph
            orig_length = data["length"]
            if orig_length <= self.max_edge_length:
                continue  # no need to steinerize

            p1 = (mst.nodes[u]["lat"], mst.nodes[u]["lng"])
            p2 = (mst.nodes[v]["lat"], mst.nodes[v]["lng"])

            # Get intermediate points (excluding endpoints)
            intermediates = self._great_circle_intermediates(
                p1[0], p1[1], p2[0], p2[1], self.max_edge_length
            )

            if not intermediates:
                continue

            # ─── Build chain: original u → new1 → new2 → ... → new_k → original v ───
            prev = u
            new_nodes_in_chain = []

            for lat, lon in intermediates:
                # Create new node
                new_id = new_node_counter
                new_node_counter += 1

                # Add to global lists
                mst.add_node(new_id)
                mst.nodes[new_id]["lat"] = lat
                mst.nodes[new_id]["lng"] = lon
                mst.nodes[new_id]["type"] = "pole"
                mst.nodes[new_id]["name"] = "pole"
                mst.nodes[new_id]["used"] = True

                prev_node = mst.nodes(data=True)[prev]

                # Connect previous → new
                d = self.haversine_meters(prev_node['lat'], prev_node['lng'], lat, lon)
                weight = self.calc_edge_weight(d, voltage="low")

                mst.add_edge(prev, new_id,
                             weight=weight,
                             length=d,
                             voltage="low")

                prev = new_id

            original_node = mst.nodes(data=True)[v]

            # Final segment: last new node → original
            d = self.haversine_meters(prev_node['lat'], prev_node['lng'], original_node['lat'], original_node['lng'])
            weight = d * costs["lowVoltageCostPerMeter"]

            mst.add_edge(prev, v,
                         weight=weight,
                         length=d,
                         voltage="low")

            # ─── Remove the original long edge ────────────────────────────────
            mst.remove_edge(u, v)

        return mst
