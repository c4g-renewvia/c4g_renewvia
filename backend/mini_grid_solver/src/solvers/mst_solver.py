# src/solvers/simple_mst_solver.py
from typing import List, Literal

import networkx as nx

from .base_mini_grid_solver import BaseMiniGridSolver
from .registry import register_solver
from ..utils.models import (
    Node,
    OutputEdge,
    SolverResult,
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

    def solve(self) -> SolverResult:
        # 1. Parse input
        nodes, coords, source_idx, terminal_indices, names, costs = self.parse_and_validate_input()

        n = len(coords)
        if n < 2:
            raise ValueError("Need at least source + 1 terminal")

        # 3. Compute full distance matrix
        dist_matrix = self.compute_distance_matrix(coords)

        pole_indices = [n.index for n in nodes if n.type == "pole"]

        if len(pole_indices) > 0:

            DG = self.build_directed_graph_for_arborescence(
                source_idx, terminal_indices, pole_indices, dist_matrix, costs,
                max_pole_to_pole_lv=30,
                max_pole_to_terminal_lv=30

            )

            arbo = nx.minimum_spanning_arborescence(DG, attr="weight", default=1e18, preserve_attrs=True)
            mst = self.prune_dead_end_pole_branches(arbo, pole_indices, terminal_indices)

            # 7. All nodes are used (since it's a spanning tree)
            used_nodes = self.extract_used_nodes(mst, nodes)
        else:
            G = nx.complete_graph(n)
            for i in range(n):
                for j in range(i + 1, n):
                    d = dist_matrix[i, j]
                    weight = d * costs["lowVoltageCostPerMeter"]
                    G.edges[i, j]["weight"] = weight
                    G.edges[i, j]["length"] = d
            mst = nx.minimum_spanning_tree(G)
            used_nodes = nodes


        # 8. Compute total lengths and assign voltage levels (all low for now)
        edges, total_low_m, total_high_m = self._build_edges_and_lengths(mst, used_nodes)

        # 9. No extra poles used
        num_poles = len(pole_indices)

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
