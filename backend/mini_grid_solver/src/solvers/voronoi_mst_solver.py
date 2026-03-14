from .candidate_mst_solver import *
from .registry import register_solver


@register_solver
class StaticVoronoiMSTSolver(CandidateMSTSolver):

    def __init__(self, request: SolverRequest):
        request.params['candidate_algorithm'] = 'voronoi'
        super().__init__(request)
