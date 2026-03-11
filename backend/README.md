# Mini-Grid Optimizer Documentation

This library provides a comprehensive framework for designing and optimizing rural power distribution networks. It focuses on minimizing total project costs by balancing wire lengths and pole placements while adhering to strict geographical and physical constraints.

---

## Project File Structure

Below is the directory structure for the Mini-Grid Optimizer library based on the provided source files:

```text
project_root/
│
├── src/
│   ├── solvers/
│   │   ├── __init__.py
│   │   ├── base_mini_grid_solver.py    # Abstract base class for all solvers
│   │   ├── candidate_mst_solver.py     # Base for candidate-based optimization
│   │   ├── fermat_mst_solver.py        # Solver using Fermat-Torricelli points
│   │   ├── iterated_1_steiner_solver.py # Iterative refinement solver
│   │   ├── mst_solver.py               # Simple MST baseline solver
│   │   ├── registry.py                 # Solver registration utility
│   │   ├── steinerized_mst.py          # MST with edge fragmentation
│   │   └── voronoi_mst_solver.py       # Solver using Voronoi vertices
│   │
│   └── utils/
│       ├── __init__.py
│       ├── models.py                   # Pydantic data models
│       └── utils.py                    # General helper functions
│
└── 179_buildings.csv                   # Building footprint data for filtering
```

---

## Core Architecture

### 1. Data Models (`models.py`)

Built on Pydantic, these models ensure type safety and structured communication:

- **`SolverRequest`**: Captures input points (latitude/longitude), cost parameters, and solver-specific parameters.
- **`Node`**: A unified representation of every point in the network, categorized as a `source`, `terminal`, or `pole`.
- **`OutputEdge`**: Represents a connection between two nodes, including metadata for length and voltage levels.
- **`SolverResult`**: The final output containing the network topology, total costs, and optional debug metrics.

### 2. Base Solver (`base_mini_grid_solver.py`)

The `BaseMiniGridSolver` is an abstract base class that provides essential utilities for all optimization algorithms:

- **Geographical Calculations**: Implements the Haversine formula to calculate great-circle distances in meters.
- **Input Canonicalization**: Automatically identifies power sources via keyword detection (e.g., "substation", "generator") and standardizes point names.
- **Vectorized Math**: Uses NumPy-based `haversine_vec` to compute distance matrices efficiently.

### 3. Registry Pattern (`registry.py`)

Solvers are decoupled from the main execution logic through a central `SOLVER_REGISTRY`. This allows developers to add new algorithms by simply applying the `@register_solver` decorator.

---

## Available Solvers

| Solver                         | Strategy                      | Key Features                                                                                                    |
| :----------------------------- | :---------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| **`SimpleMSTSolver`**          | Baseline MST                  | Computes a standard Minimum Spanning Tree using only original points; useful as a lower-bound reference.        |
| **`SteinerizedMSTSolver`**     | MST + Fragmentation           | Builds an MST and inserts intermediate poles along any edge exceeding a maximum span (e.g., 30m).               |
| **`VoronoiMSTSolver`**         | Static Voronoi Steiner Points | Generates potential pole locations using Voronoi vertices points to reduce total wire length.                   |
| **`FermatMSTSolver`**          | Static Fermat Steiner Points  | Generates potential pole locations using Fermat-Torricelli points to reduce total wire length.                  |
| **`IteratedOneSteinerSolver`** | Greedy Iteration              | Iteratively adds candidate poles from Voronoi, Fermat, and collinear sets to find the most cost-effective tree. |

---

## Specialized Optimization Logic

### Advanced Candidate Generation (`candidate_mst_solver.py`)

- **Voronoi Candidates**: Identifies optimal junction points based on the geometry of building clusters.
- **Fermat-Torricelli Points**: Specifically targets 3-point junctions to minimize the sum of distances to vertices.
- **Building Filtering**: Includes logic to remove candidate poles that fall inside building footprints based on CSV-provided geometries.

### Edge Fragmentation

Solvers include logic to break long spans into segments. This ensures that every cable length in the resulting `SolverResult` respects physical limits like the `MAX_POLE_TO_POLE_LV` threshold.

---

## Voltage Support & Expansion

### Current Low Voltage (LV) Implementation

The library currently prioritizes low-voltage distribution for local micro-grids:

- **Default Classification**: All solvers currently default to assigning a `"low"` voltage type to every edge.
- **Costing**: Financial estimates primarily utilize the `lowVoltageCostPerMeter` parameter provided in the `SolverRequest`.
- **Physical Constraints**: Edge fragmentation and candidate generation are tuned to typical LV span limits, such as a 30-meter maximum length.
- **Metric Reporting**: The `totalHighVoltageMeters` field is initialized but generally returns `0.0` in the current iteration of the solvers.

### Expanding to High Voltage (HV) Support

The architecture is designed to be "HV-ready" and can be expanded using the following strategies:

- **Dual-Voltage Models**: The `OutputEdge` and `SolverResult` models already support a `"high"` voltage literal and separate cost tracking fields.
- **Trunk vs. Branch Logic**:
  - You can modify the `_build_edges_and_lengths` method to identify "trunk" lines.
  - Assign `"high"` voltage to edges directly connected to the source or to nodes serving more than a certain number of downstream terminals.
- **Distance-Based Upgrading**:
  - Update `build_directed_graph_for_arborescence` to evaluate both LV and HV weights for the same edge.
  - Higher voltage costs can be applied to long-distance spans where voltage drop across LV lines would be prohibitive.
- **Transformer Node Insertion**:
  - New node types can be added to the `Node` model to represent transformers where the network transitions from high to low voltage.
  -

---

## Getting Started

### Basic Implementation

To run a basic optimization, define your request and initialize a registered solver:

```python
from src.utils.models import SolverRequest
from src.solvers.steinerized_mst import SteinerizedMSTSolver

# Define request with lat/lng points and costs
request = SolverRequest(
    points=[
        {"lat": -1.286389, "lng": 36.817223, "Name": "Power Source", "Type": 'source},
        {"lat": -1.285556, "lng": 36.818056, "Name": "Building A", "Type": "terminal"}
    ],
    costs={
        "poleCost": 100.0,
        "lowVoltageCostPerMeter": 10.0,
        "highVoltageCostPerMeter": 20.0
    }
)

# Solve and retrieve metrics
solver = SteinerizedMSTSolver(request)
result = solver.solve()
print(f"Poles used: {result.numPolesUsed}")
```
