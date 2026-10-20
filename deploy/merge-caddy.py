#!/usr/bin/env python3
"""Replace only a standalone Leanwise site, or add its isolated import."""
from pathlib import Path
import json
import re
import sys


def tokens(source):
    """Caddy braces are tokens; braces inside quotes/placeholders are data."""
    result = []
    index = 0
    while index < len(source):
        char = source[index]
        if char.isspace():
            index += 1
            continue
        if char == '#':
            ending = source.find('\n', index)
            index = len(source) if ending < 0 else ending + 1
            continue
        start = index
        if char in ('"', '`'):
            quote = char
            index += 1
            while index < len(source):
                if quote == '"' and source[index] == '\\':
                    index += 2
                elif source[index] == quote:
                    index += 1
                    break
                else:
                    index += 1
            else:
                raise ValueError('Caddy 配置中存在未闭合的引号。')
        else:
            while index < len(source) and not source[index].isspace() and source[index] != '#':
                index += 1
        result.append((source[start:index], start, index))
    return result


def configured_hosts(value):
    hosts = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key == 'host' and isinstance(item, list):
                hosts.extend(item)
            else:
                hosts.extend(configured_hosts(item))
    elif isinstance(value, list):
        for item in value:
            hosts.extend(configured_hosts(item))
    return hosts


def merge(source, domain, managed, pending, adapted):
    token_list = tokens(source)
    replacement = f'import {pending}'
    import_pattern = re.compile(r'^([ \t]*)import[ \t]+["\']?' + re.escape(managed) + r'["\']?[ \t]*(?:#[^\n]*)?$', re.MULTILINE)
    managed_imports = list(import_pattern.finditer(source))
    if len(managed_imports) > 1:
        raise ValueError('本站 import 重复，请保留一条后重试。')

    depth = 0
    target_blocks = []
    opening = None
    for value, start, end in token_list:
        if value == '{':
            if depth == 0:
                line_start = source.rfind('\n', 0, start) + 1
                header = source[line_start:start].strip()
                addresses = [part.strip().strip('"') for part in header.replace(',', ' ').split()]
                aliases = {domain, f'https://{domain}', f'{domain}:443', f'https://{domain}:443'}
                if any(address in aliases for address in addresses):
                    if len(addresses) != 1:
                        raise ValueError(f'{domain} 与其他域名共享同一站点块。请先将本站独立为一个块，保留其他域名配置。')
                    opening = line_start
                else:
                    opening = None
            depth += 1
        elif value == '}':
            depth -= 1
            if depth < 0:
                raise ValueError('Caddy 大括号不匹配。')
            if depth == 0 and opening is not None:
                target_blocks.append((opening, end))
                opening = None
    if depth != 0:
        raise ValueError('Caddy 大括号不匹配。')
    if len(target_blocks) > 1 or (target_blocks and managed_imports):
        raise ValueError('本站已有多处配置。请先定位并保留一个独立站点块或一条本站 import。')
    if managed_imports:
        match = managed_imports[0]
        return source[:match.start()] + replacement + source[match.end():]
    if target_blocks:
        start, end = target_blocks[0]
        return source[:start] + replacement + source[end:]
    # An imported site or a wildcard cannot be safely rewritten in this file.
    hosts = configured_hosts(adapted)
    inherited = any(host == domain or (isinstance(host, str) and host.startswith('*.') and domain.endswith(host[1:])) for host in hosts)
    uncommented = '\n'.join(line.split('#', 1)[0] for line in source.splitlines())
    if inherited or domain in uncommented:
        raise ValueError(f'本站位于 import 文件、通配符或非标准地址中。请运行 grep -R -n -- "{domain}" /etc/caddy，将本站独立块移至 /etc/caddy/Caddyfile，保留其他网站与 import。详见 deploy/README.md。')
    return source.rstrip() + '\n\n# Leanwise: isolated site configuration\n' + replacement + '\n'


def main():
    if len(sys.argv) != 7:
        raise ValueError('参数数量无效。')
    original, candidate, domain, managed, pending, adapted_path = sys.argv[1:]
    source = Path(original).read_text(encoding='utf-8')
    adapted = json.loads(Path(adapted_path).read_text(encoding='utf-8'))
    result = merge(source, domain, managed, pending, adapted)
    Path(candidate).write_text(result, encoding='utf-8')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        print(f'Leanwise: {error}', file=sys.stderr)
        sys.exit(1)
