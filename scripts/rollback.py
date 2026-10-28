#!/usr/bin/env python3
"""Use the same idle, model and restart checks when selecting an older compatible release."""
import pathlib,runpy
runpy.run_path(str(pathlib.Path(__file__).with_name('upgrade.py')),run_name='__main__')
