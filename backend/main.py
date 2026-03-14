from pykml import parser

from mini_grid_solver.src import SimpleMSTSolver, GreedyNSteinerSolver, StaticFermatMSTSolver, StaticVoronoiMSTSolver, \
    SteinerizedMSTSolver
from mini_grid_solver.src.solvers.registry import SOLVER_REGISTRY
from mini_grid_solver.src.utils.models import Solver
from mini_grid_solver.src.utils import *
import pandas as pd

simple = True
if simple:
    coords = pd.read_csv("test_data_sets/BuildingCoordinates.csv").to_dict(orient="records")
else:
    kml_file_path = "test_data_sets/renewvia_ground_truth.kml"

    with open(kml_file_path, 'r', encoding="utf-8") as f:
        root = parser.parse(f).getroot()

    coords = []
    for folder in root.Document.Folder:
        for placemark in folder.Placemark:
            lat, lng, _ = str(placemark.Point.coordinates).strip(" ").strip("\n").strip(" ").split(",")
            coords.append({
                "name": str(placemark.name),
                "lat": float(lat),
                "lng": float(lng),
                "type": str(placemark.description).split(" ")[1]
            }
            )

req = SolverRequest(
    params={"n": 2},
    points=coords,
    costs={
        "poleCost": 100.0,
        "lowVoltageCostPerMeter": 10.0,
        "highVoltageCostPerMeter": 20.0,
    },
    debug=2,
)

solvers = {"solvers": []}
for solver_name, solver_class in SOLVER_REGISTRY.items():
    print(solver_name, solver_class)
    params = solver_class.get_input_params()
    print(params)
    solvers['solvers'].append(Solver(name = str(solver_name), params = params))

print(solvers)
# result = SimpleMSTSolver(req).solve()
# result = StaticFermatMSTSolver(req).solve()
result = SteinerizedMSTSolver(req).solve()
# result = StaticVoronoiMSTSolver(req).solve()
# result = GreedyNSteinerSolver(req).solve()


print(result)
