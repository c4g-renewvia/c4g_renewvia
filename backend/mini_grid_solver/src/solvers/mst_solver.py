# src/solvers/simple_mst_solver.py
from typing import List

import networkx as nx

from .mini_grid_solver import BaseMiniGridSolver
from .registry import register_solver
from ..utils.models import (
    Node,
    OutputEdge,
    OptimizationResult,
)


@register_solver
class SimpleMSTSolver(BaseMiniGridSolver):
    """
    Very simple MST solver that:

    - Uses **only the original points** (no candidate poles)
    - Computes an undirected MST on all points
    - Orients edges away from the source (makes it a tree rooted at source)
    - Assigns all connections as "low voltage" (can be changed later)
    - No fragmentation, no pruning, no extra poles

    Good as a baseline / lower bound reference.
    """

    def solve(self) -> OptimizationResult:
        # 1. Parse input
        coords, source_idx, terminal_indices, names, costs = self.parse_and_validate_input()

        n = len(coords)
        if n < 2:
            raise ValueError("Need at least source + 1 terminal")

        # 2. Create nodes (only originals — no candidates)
        nodes: List[Node] = []
        for i in range(n):
            node_type = "source" if i == source_idx else "terminal"
            name = names[i] if i < len(names) else f"Point {i + 1}"
            nodes.append(Node(
                index=i,
                lat=float(coords[i, 0]),
                lng=float(coords[i, 1]),
                type=node_type,
                name=name,
                is_candidate=False,
                used=True,  # all originals are used
            ))

        # 3. Compute full distance matrix
        dist_matrix = self.compute_distance_matrix(coords)

        # 4. Build complete undirected graph with distances as weights
        G = nx.complete_graph(n)
        for i in range(n):
            for j in range(i + 1, n):
                d = dist_matrix[i, j]
                G.edges[i, j]["weight"] = d
                G.edges[i, j]["length"] = d

        # 5. Compute MST (Kruskal or Prim — NetworkX uses Kruskal by default)
        mst_undirected = nx.minimum_spanning_tree(G, algorithm="kruskal", weight="weight")

        # 6. Orient the tree away from the source (make it a rooted tree / arborescence)
        #    We do a BFS from source and direct edges outward
        mst_directed = nx.DiGraph()
        visited = set()
        queue = [source_idx]

        while queue:
            u = queue.pop(0)
            if u in visited:
                continue
            visited.add(u)

            for v in mst_undirected.neighbors(u):
                if v not in visited:
                    # Direct edge u → v (away from source)
                    length = mst_undirected.edges[u, v]["length"]
                    mst_directed.add_edge(
                        u, v,
                        weight=length,
                        length=length,
                        voltage="low"  # everything low for this simple version
                    )
                    queue.append(v)

        # 7. All nodes are used (since it's a spanning tree)
        used_nodes = nodes  # reference — all are included

        # 8. Build output edges
        edges: List[OutputEdge] = []
        total_low_m = 0.0
        total_high_m = 0.0

        for u, v, data in mst_directed.edges(data=True):
            length_m = data.get("length", 0.0)
            voltage = data.get("voltage", "low")

            start_node = nodes[u]
            end_node = nodes[v]

            edges.append(OutputEdge(
                start={
                    "lat": start_node.lat,
                    "lng": start_node.lng,
                    "name": start_node.name,
                    "type": start_node.type,
                },
                end={
                    "lat": end_node.lat,
                    "lng": end_node.lng,
                    "name": end_node.name,
                    "type": end_node.type,
                },
                lengthMeters=round(length_m, 2),
                voltage=voltage,
            ))

            if voltage == "low":
                total_low_m += length_m
            elif voltage == "high":
                total_high_m += length_m

        # 9. No extra poles used
        num_poles = 0

        # 10. Build result using helper
        debug_info = None
        if self.request.debug:
            debug_info = {
                "method": "simple_mst_no_candidates",
                "original_points": len(coords),
                "poles_used": 0,
                "edges_count": len(edges),
                "total_length_m": round(total_low_m + total_high_m, 2),
            }

        return self.build_simple_result(
            edges=edges,
            used_nodes=used_nodes,
            total_low_m=total_low_m,
            total_high_m=total_high_m,
            num_poles=num_poles,
            debug_info=debug_info,
        )
