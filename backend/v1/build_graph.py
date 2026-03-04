from typing import List, Tuple

import networkx as nx
import numpy as np

from .utils import Node

MIN_POLE_TO_TERMINAL = 10.0
MAX_POLE_TO_TERMINAL_LV = 30.0

MIN_POLE_TO_POLE = 10.0
MAX_POLE_TO_POLE_LV = 30.0


def build_directed_graph_for_arborescence(
        source_idx,
        terminal_indices,
        pole_indices,
        dist_matrix,
        costs,
) -> nx.DiGraph:
    """
    Builds a directed graph for use in finding a minimum-cost arborescence given
    a set of coordinates, indices, and constraints.

    This function constructs a directed graph where poles and terminals are represented
    as nodes, and edges represent potential connections between them. Different weight
    and voltage attributes are applied to the edges depending on their type (pole-to-terminal,
    pole-to-pole, or source-to-pole/terminal connections).

    Args:
        source_idx: Integer index representing the source node (e.g., a substation).
        terminal_indices: List of integers representing indices of all terminals.
        pole_indices: List of integers representing indices of all poles.
        dist_matrix: 2D matrix where each element represents the distance between nodes.
        costs: Dictionary storing cost values for graph construction. Specifically,
               it should include the `"poleCost"` key to determine the cost addition
               for pole-to-pole connections.

    Returns:
        nx.DiGraph: A directed graph with the defined nodes and edges.

    """
    # pole_cost = float(costs.get("poleCost", 1000.0))
    # low_voltage_cost_per_meter = float(costs.get("lowVoltageCostPerMeter", 4.0))
    # high_voltage_cost_per_meter = float(costs.get("highVoltageCostPerMeter", 10.0))

    DG = nx.DiGraph()

    # Directed: poles → terminals (service drops)
    for p in pole_indices:
        for h in terminal_indices:
            d = dist_matrix[p, h]
            if 0.1 < d:
                w = d  # TODO: Adjust weight based on costs
                DG.add_edge(p, h, weight=w, length=d, voltage="low")

    # Bidirectional pole ↔ pole (undirected spans)
    for i in range(len(pole_indices)):
        for j in range(i + 1, len(pole_indices)):
            p1, p2 = pole_indices[i], pole_indices[j]
            d = dist_matrix[p1, p2]
            w = d + 100  # TODO: Adjust weight based on costs
            if 0.1 < d:
                DG.add_edge(p1, p2, weight=w, length=d, voltage="low")
                DG.add_edge(p2, p1, weight=w, length=d, voltage="low")

    # Directed: source → poles (main trunk)
    for p in pole_indices:
        d = dist_matrix[source_idx, p]
        if 0.1 < d:
            w = d  # TODO: Adjust weight based on costs
            DG.add_edge(source_idx, p, weight=w, length=d, voltage="low")

    return DG


def prune_dead_end_pole_branches(arbo: nx.DiGraph, pole_indices: list, terminal_indices) -> nx.DiGraph:
    """
    Prunes dead-end pole branches in a Directed Graph (DiGraph).

    This function removes leaf nodes in the provided graph that represent poles and do not serve
    any terminal nodes in their subtree. The pruning process continues iteratively until no such
    dead-end poles remain in the graph. It modifies a copy of the input graph without affecting
    the original.

    Args:
        arbo (nx.DiGraph): A directed graph representing the network structure.
        pole_indices (list): A list of node indices representing poles in the graph.
        terminal_indices (list): A list of node indices representing terminals in the graph.

    Returns:
        nx.DiGraph: A new directed graph with dead-end pole branches removed.
    """
    arbo = arbo.copy()
    removed = True
    while removed:
        removed = False
        leaves = [n for n in arbo.nodes() if arbo.out_degree(n) == 0]
        for leaf in leaves:
            if leaf in pole_indices:
                # Check if this leaf (or its subtree) serves any terminal
                descendants = nx.descendants(arbo, leaf) | {leaf}
                if not any(d in terminal_indices for d in descendants):
                    # No terminal served → safe to remove
                    predecessors = list(arbo.predecessors(leaf))
                    for pred in predecessors:
                        arbo.remove_edge(pred, leaf)
                    arbo.remove_node(leaf)
                    removed = True
    return arbo


def fragment_long_edges_with_coords(
        mst: nx.DiGraph,
        nodes: List,
        max_length_m: float = 30.0,
        min_segment_length: float = 5.0,
) -> Tuple[nx.DiGraph, List]:
    """
    Break long edges (> max_length_m meters) into multiple shorter segments by
    inserting new intermediate pole nodes along the straight line between endpoints.

    Args:
        mst: The current minimum spanning arborescence (directed graph)
        nodes: Current list of Node objects (will be extended with new poles)
        max_length_m: Edges longer than this are fragmented (default: 30m)
        min_segment_length: Don't create segments shorter than this (safety)

    Returns:
        (updated_mst, updated_nodes)
    """
    # We'll build a new graph and extend the nodes list
    new_mst = nx.DiGraph()
    new_nodes = nodes.copy()  # shallow copy — we'll append new Node objects

    # Quick lookup: index → Node
    node_by_index = {n.index: n for n in new_nodes}

    # Keep track of the highest index used so far
    next_index = max(n.index for n in new_nodes) + 1

    # Copy all short edges directly + fragment long ones
    for u, v, data in list(mst.edges(data=True)):
        length_m = data.get("length", 0.0)
        voltage = data.get("voltage", "unknown")

        if length_m <= max_length_m:
            # Short enough → copy edge as-is
            new_mst.add_edge(u, v, **data)
            continue

        # Long edge → fragment
        start_node = node_by_index[u]
        end_node = node_by_index[v]

        start_coord = np.array([start_node.lat, start_node.lng])
        end_coord = np.array([end_node.lat, end_node.lng])

        # Direction vector
        direction = end_coord - start_coord
        total_length = length_m  # already in meters

        # How many full segments do we want?
        num_segments = max(2, int(np.ceil(total_length / max_length_m)))
        segment_length = total_length / num_segments

        if segment_length < min_segment_length:
            # Edge is long but segments would be too small → just leave it
            # (or you could force at least 2 segments — decide policy)
            new_mst.add_edge(u, v, **data)
            continue

        # We'll create (num_segments - 1) new intermediate nodes
        current = start_coord.copy()
        prev_idx = u

        for i in range(1, num_segments):
            # Move along the line
            fraction = i / num_segments
            current = start_coord + fraction * direction

            # Create new pole node
            new_node = Node(
                index=next_index,
                lat=float(current[0]),
                lng=float(current[1]),
                type="pole",
                name=None,  # will be named later if used
                is_candidate=True,
                used=True,  # since it's going into the tree
            )
            new_nodes.append(new_node)
            node_by_index[next_index] = new_node

            # Connect previous → new
            new_mst.add_edge(
                prev_idx,
                next_index,
                length=segment_length,
                voltage=voltage,
                # copy any other attributes you care about
            )

            prev_idx = next_index
            next_index += 1

        # Final segment: last intermediate → original end
        new_mst.add_edge(
            prev_idx,
            v,
            length=segment_length,
            voltage=voltage,
        )

    # Optional: copy graph-level attributes if any exist
    new_mst.graph.update(mst.graph)

    return new_mst, new_nodes
