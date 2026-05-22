"""pytest config: register custom markers used in the test suite."""


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "no_gstack_stub: opt out of the autouse _fetch_via_gstack_browse stub "
        "so the test can exercise the real gstack-browse code path with its "
        "own mocks.",
    )
