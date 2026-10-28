#!/usr/bin/env python3
"""Validate repository-relative Markdown targets; external URLs are not fetched."""
import json,pathlib,re,sys,urllib.parse
root=pathlib.Path(__file__).resolve().parent.parent
paths=[*root.glob('*.md'),*root.glob('docs/**/*.md'),*root.glob('.github/**/*.md')];errors=[];count=0
for path in paths:
    for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)',path.read_text()):
        target=target.split(' "',1)[0].strip('<>');url=urllib.parse.urlsplit(target)
        if url.scheme or url.netloc or not url.path:continue
        resolved=(path.parent/urllib.parse.unquote(url.path)).resolve();count+=1
        if not resolved.is_relative_to(root) or not resolved.exists():errors.append({'file':str(path.relative_to(root)),'target':target})
print(json.dumps({'documents':len(paths),'relativeLinks':count,'errors':errors},indent=2));sys.exit(1 if errors else 0)
