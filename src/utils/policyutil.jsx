export function PolicyTypeName(s) {
  if (!s.host && !s.userName) {
    return "Global Policy";
  }

  if (!s.userName) {
    return "Host: " + s.host;
  }

  if (!s.path) {
    return "User: " + s.userName + "@" + s.host;
  }

  return "Directory: " + s.userName + "@" + s.host + ":" + s.path;
}

export function sourceQueryStringParams(src) {
  return (
    "userName=" +
    encodeURIComponent(src.userName) +
    "&host=" +
    encodeURIComponent(src.host) +
    "&path=" +
    encodeURIComponent(src.path)
  );
}

export function policyEditorURL(s) {
  return "/policies/edit?" + sourceQueryStringParams(s);
}
