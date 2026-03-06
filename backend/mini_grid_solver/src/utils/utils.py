import numpy as np


def build_bounding_box(coords):
    """
    Compute axis-aligned bounding box from array of [lat, lon] points.

    Args:
        coords: np.ndarray of shape (n, 2) where each row is [latitude, longitude]
                or list of [lat, lon] pairs

    Returns:
        dict: {'min_lat': float, 'max_lat': float, 'min_lon': float, 'max_lon': float}
              or None if input is empty/invalid
    """
    if len(coords) == 0:
        return None

    # Convert to numpy array if it's a list
    coords = np.asarray(coords)

    if coords.ndim != 2 or coords.shape[1] != 2:
        raise ValueError("coords must be (n, 2) array or list of [lat, lon] pairs")

    min_lat = np.min(coords[:, 0])
    max_lat = np.max(coords[:, 0])
    min_lon = np.min(coords[:, 1])
    max_lon = np.max(coords[:, 1])

    return {
        'min_lat': float(min_lat),
        'max_lat': float(max_lat),
        'min_lon': float(min_lon),
        'max_lon': float(max_lon)
    }
