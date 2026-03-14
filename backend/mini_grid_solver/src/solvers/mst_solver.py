# src/solvers/simple_mst_solver.py
from typing import List, Literal, Tuple

import networkx as nx
import numpy as np

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

    def _solve(self, input_tuple) -> Tuple[nx.DiGraph, List[Node], np.ndarray]:

        nodes, coords, source_idx, terminal_indices, names, costs = input_tuple

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
                    G.edges[i, j]["voltage"] = "low"
            mst = nx.minimum_spanning_tree(G, weight="weight")
            used_nodes = nodes


        return mst, used_nodes, coords
