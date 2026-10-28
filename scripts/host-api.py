#!/usr/bin/env python3
"""Authenticated loopback API helper; token/cookie stay in memory."""
import http.client,json,pathlib,sys,urllib.parse

def call(root,path='/feishu/api/status',body=None,timeout=210):
    url=urllib.parse.urlparse((pathlib.Path(root)/'state/web-login-url').read_text().strip())
    if url.hostname!='127.0.0.1': raise ValueError('Only loopback is supported')
    c=http.client.HTTPConnection(url.hostname,url.port,timeout=timeout)
    c.request('GET','/?'+url.query);r=c.getresponse();r.read()
    if r.status!=303: raise RuntimeError('DSH login exchange failed')
    cookie=r.getheader('Set-Cookie').split(';',1)[0];c.close()
    c=http.client.HTTPConnection(url.hostname,url.port,timeout=timeout)
    headers={'Cookie':cookie,'Origin':f'http://127.0.0.1:{url.port}'}
    if body is not None:headers['Content-Type']='application/json'
    c.request('POST' if body is not None else 'GET',path,json.dumps(body) if body is not None else None,headers)
    r=c.getresponse();data=json.loads(r.read());c.close()
    if r.status!=200:raise RuntimeError('Authenticated API failed: '+str(r.status)+' '+str(data.get('error','unknown')))
    return data
if __name__=='__main__':
    print(json.dumps(call(sys.argv[1],sys.argv[2] if len(sys.argv)>2 else '/feishu/api/status',json.loads(sys.argv[3]) if len(sys.argv)>3 else None),ensure_ascii=False,indent=2))
