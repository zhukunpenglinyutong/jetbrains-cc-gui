/**
 * 文件图标映射工具
 * 返回内联的 SVG 字符串，用于支持 vite-plugin-singlefile 打包
 */

import * as icons from './icons';

/**
 * 根据文件扩展名获取图标 SVG
 */
export function getFileIcon(extension?: string, fileName?: string): string {
  // 1. 优先匹配文件名
  if (fileName) {
    const name = fileName.toLowerCase();
    const nameMap: Record<string, string> = {
      'gradlew': icons.icon_gradle,
      'gradlew.bat': icons.icon_gradle,
      'build.gradle': icons.icon_gradle,
      'build.gradle.kts': icons.icon_gradle,
      'pom.xml': icons.icon_maven,
      'license': icons.icon_certificate,
      'license.txt': icons.icon_certificate,
      'license.md': icons.icon_certificate,
      'licence': icons.icon_certificate,
      'licence.txt': icons.icon_certificate,
      'licence.md': icons.icon_certificate,
      'dockerfile': icons.icon_docker,
      'docker-compose.yml': icons.icon_docker,
      'docker-compose.yaml': icons.icon_docker,
      'makefile': icons.icon_makefile,
      'jenkinsfile': icons.icon_jenkins,
      '.gitignore': icons.icon_git,
      '.gitkeep': icons.icon_git,
      '.gitattributes': icons.icon_git,
      '.gitmodules': icons.icon_git,
      '.editorconfig': icons.icon_editorconfig,
      '.env': icons.icon_dotjs,
      '.env.local': icons.icon_dotjs,
      '.env.development': icons.icon_dotjs,
      '.env.production': icons.icon_dotjs,
      '.npmrc': icons.icon_npm,
      '.nvmrc': icons.icon_nodejs,
      '.prettierrc': icons.icon_prettier,
      '.eslintrc': icons.icon_eslint,
      '.eslintrc.js': icons.icon_eslint,
      '.eslintrc.json': icons.icon_eslint,
      '.babelrc': icons.icon_babel,
      'babel.config.js': icons.icon_babel,
      'babel.config.json': icons.icon_babel,
      'package.json': icons.icon_nodejs,
      'package-lock.json': icons.icon_nodejs,
      'tsconfig.json': icons.icon_typescript,
      'jsconfig.json': icons.icon_javascript,
      'vite.config.js': icons.icon_vite,
      'vite.config.ts': icons.icon_vite,
      'vite.config.cjs': icons.icon_vite,
      'vite.config.mjs': icons.icon_vite,
      'webpack.config.js': icons.icon_webpack,
      'webpack.config.ts': icons.icon_webpack,
      'webpack.config.cjs': icons.icon_webpack,
      'webpack.config.mjs': icons.icon_webpack,
      'rollup.config.js': icons.icon_rollup,
      'rollup.config.ts': icons.icon_rollup,
      'tailwind.config.js': icons.icon_tailwindcss,
      'tailwind.config.ts': icons.icon_tailwindcss,
      'tailwind.config.cjs': icons.icon_tailwindcss,
      'postcss.config.js': icons.icon_postcss,
      'postcss.config.cjs': icons.icon_postcss,
      'next.config.js': icons.icon_next,
      'next.config.mjs': icons.icon_next,
      'nuxt.config.js': icons.icon_nuxt,
      'nuxt.config.ts': icons.icon_nuxt,
      'jest.config.js': icons.icon_jest,
      'jest.config.ts': icons.icon_jest,
      'jest.config.json': icons.icon_jest,
      'readme.md': icons.icon_readme,
      'readme.txt': icons.icon_readme,
      'readme': icons.icon_readme,
      'changelog.md': icons.icon_readme,
      'changelog': icons.icon_readme,
      'gemfile': icons.icon_ruby,
      'gemfile.lock': icons.icon_ruby,
      'rakefile': icons.icon_ruby,
      'procfile': icons.icon_settings,
      'requirements.txt': icons.icon_python,
      'pipfile': icons.icon_python,
      'pipfile.lock': icons.icon_python,
      'setup.py': icons.icon_python,
      'pyproject.toml': icons.icon_python,
      '.bashrc': icons.icon_console,
      '.zshrc': icons.icon_console,
      '.bash_profile': icons.icon_console,
      'go.mod': icons.icon_go,
      'go.sum': icons.icon_go,
      'cargo.toml': icons.icon_rust,
      'cargo.lock': icons.icon_rust,
      'composer.json': icons.icon_php,
      'composer.lock': icons.icon_php,
      'mix.exs': icons.icon_elixir,
      'mix.lock': icons.icon_elixir,
      'cname': icons.icon_http,
    };
    if (nameMap[name]) {
      return nameMap[name];
    }

    // 检查测试文件
    if (name.endsWith('.test.ts') || name.endsWith('.test.tsx') || name.endsWith('.test.js') || name.endsWith('.test.jsx') ||
        name.endsWith('.spec.ts') || name.endsWith('.spec.tsx') || name.endsWith('.spec.js') || name.endsWith('.spec.jsx')) {
      return icons.icon_test_ts;
    }
  }

  if (!extension) {
    return icons.icon_file;
  }

  const ext = extension.toLowerCase();
  const iconMap: Record<string, string> = {
    // 编程语言 - 主流
    ts: icons.icon_typescript,
    tsx: icons.icon_typescript,
    cts: icons.icon_typescript,
    mts: icons.icon_typescript,
    js: icons.icon_javascript,
    jsx: icons.icon_javascript,
    cjs: icons.icon_javascript,
    mjs: icons.icon_javascript,
    py: icons.icon_python,
    java: icons.icon_java,
    jar: icons.icon_java,
    war: icons.icon_java,
    go: icons.icon_go,
    rs: icons.icon_rust,
    php: icons.icon_php,
    c: icons.icon_c,
    cpp: icons.icon_cpp,
    cc: icons.icon_cpp,
    cxx: icons.icon_cpp,
    'c++': icons.icon_cpp,
    kt: icons.icon_kotlin,
    kts: icons.icon_kotlin,
    swift: icons.icon_swift,
    rb: icons.icon_ruby,

    // 编程语言 - 扩展
    cs: icons.icon_csharp,
    csproj: icons.icon_csharp,
    sln: icons.icon_csharp,
    scala: icons.icon_scala,
    sc: icons.icon_scala,
    pl: icons.icon_perl,
    pm: icons.icon_perl,
    lua: icons.icon_lua,
    r: icons.icon_r,
    rmd: icons.icon_r,
    dart: icons.icon_dart,
    ex: icons.icon_elixir,
    exs: icons.icon_elixir,
    erl: icons.icon_erlang,
    hrl: icons.icon_erlang,
    hs: icons.icon_haskell,
    lhs: icons.icon_haskell,
    clj: icons.icon_clojure,
    cljs: icons.icon_clojure,
    cljc: icons.icon_clojure,
    fs: icons.icon_fsharp,
    fsi: icons.icon_fsharp,
    fsx: icons.icon_fsharp,
    groovy: icons.icon_groovy,
    gvy: icons.icon_groovy,
    jl: icons.icon_julia,
    ml: icons.icon_ocaml,
    mli: icons.icon_ocaml,
    pas: icons.icon_pascal,
    pp: icons.icon_pascal,
    rkt: icons.icon_racket,
    scm: icons.icon_scheme,
    lisp: icons.icon_lisp,
    lsp: icons.icon_lisp,
    f: icons.icon_fortran,
    f90: icons.icon_fortran,
    f95: icons.icon_fortran,
    cob: icons.icon_cobol,
    cbl: icons.icon_cobol,
    asm: icons.icon_assembly,
    s: icons.icon_assembly,
    d: icons.icon_d,
    nim: icons.icon_nim,
    zig: icons.icon_zig,
    cr: icons.icon_crystal,
    purs: icons.icon_purescript,
    elm: icons.icon_elm,
    re: icons.icon_reason,
    rei: icons.icon_reason,
    odin: icons.icon_odin,
    mojo: icons.icon_mojo,
    gleam: icons.icon_gleam,
    res: icons.icon_rescript,
    resi: icons.icon_rescript,
    bal: icons.icon_ballerina,

    // 标记语言
    html: icons.icon_html,
    htm: icons.icon_html,
    xml: icons.icon_xml,

    // 样式文件
    css: icons.icon_css,
    scss: icons.icon_sass,
    sass: icons.icon_sass,
    less: icons.icon_less,
    styl: icons.icon_stylus,
    stylus: icons.icon_stylus,
    pcss: icons.icon_postcss,
    postcss: icons.icon_postcss,

    // 框架相关
    vue: icons.icon_vue,
    svelte: icons.icon_svelte,
    astro: icons.icon_astro,

    // 配置文件
    json: icons.icon_json,
    yaml: icons.icon_yaml,
    yml: icons.icon_yaml,
    toml: icons.icon_toml,

    // 文档
    md: icons.icon_markdown,
    markdown: icons.icon_markdown,
    mdx: icons.icon_mdx,
    tex: icons.icon_tex,
    adoc: icons.icon_asciidoc,
    asciidoc: icons.icon_asciidoc,

    // 模板语言
    haml: icons.icon_haml,
    pug: icons.icon_pug,
    jade: icons.icon_pug,
    ejs: icons.icon_ejs,
    hbs: icons.icon_handlebars,
    handlebars: icons.icon_handlebars,
    liquid: icons.icon_liquid,
    njk: icons.icon_nunjucks,
    nunjucks: icons.icon_nunjucks,
    jinja: icons.icon_jinja,
    jinja2: icons.icon_jinja,
    j2: icons.icon_jinja,
    twig: icons.icon_twig,

    // GraphQL
    graphql: icons.icon_graphql,
    gql: icons.icon_graphql,

    // Prisma
    prisma: icons.icon_prisma,

    // 构建/配置工具
    dockerfile: icons.icon_docker,
    makefile: icons.icon_makefile,
    cmake: icons.icon_cmake,
    bazelrc: icons.icon_bazel,
    gradle: icons.icon_gradle,

    // Shell/脚本
    sh: icons.icon_console,
    bash: icons.icon_console,
    zsh: icons.icon_console,
    fish: icons.icon_console,
    bat: icons.icon_console,
    cmd: icons.icon_console,
    ps1: icons.icon_powershell,
    psm1: icons.icon_powershell,
    psd1: icons.icon_powershell,

    // 数据库
    sql: icons.icon_database,
    sqlite: icons.icon_database,
    db: icons.icon_database,

    // 图片/媒体
    png: icons.icon_image,
    jpg: icons.icon_image,
    jpeg: icons.icon_image,
    gif: icons.icon_image,
    webp: icons.icon_image,
    ico: icons.icon_image,
    bmp: icons.icon_image,
    svg: icons.icon_svg,
    pdf: icons.icon_pdf,
    mp4: icons.icon_video,
    webm: icons.icon_video,
    mov: icons.icon_video,
    avi: icons.icon_video,
    mkv: icons.icon_video,
    mp3: icons.icon_audio,
    wav: icons.icon_audio,
    ogg: icons.icon_audio,
    flac: icons.icon_audio,
    ttf: icons.icon_font,
    otf: icons.icon_font,
    woff: icons.icon_font,
    woff2: icons.icon_font,
    eot: icons.icon_font,

    // 文档
    doc: icons.icon_word,
    docx: icons.icon_word,
    ppt: icons.icon_powerpoint,
    pptx: icons.icon_powerpoint,

    // 压缩/二进制
    zip: icons.icon_zip,
    tar: icons.icon_zip,
    gz: icons.icon_zip,
    rar: icons.icon_zip,
    '7z': icons.icon_zip,
    exe: icons.icon_exe,
    dll: icons.icon_dll,
    so: icons.icon_dll,
    dylib: icons.icon_dll,

    // 安全/密钥
    pem: icons.icon_key,
    key: icons.icon_key,
    pub: icons.icon_key,
    crt: icons.icon_certificate,
    cer: icons.icon_certificate,
    cert: icons.icon_certificate,

    // 日志
    log: icons.icon_log,

    // 锁文件
    lock: icons.icon_lock,

    // 协议
    proto: icons.icon_proto,
    wasm: icons.icon_webassembly,

    // 新增 - 配置文件
    coffee: icons.icon_coffee,
    dockerignore: icons.icon_docker,
    editorconfig: icons.icon_editorconfig,
    env: icons.icon_dotjs,
    gitignore: icons.icon_git,
    gitattributes: icons.icon_git,
    npmrc: icons.icon_npm,
    nvmrc: icons.icon_nodejs,
    prettierrc: icons.icon_prettier,
    prettierignore: icons.icon_prettier,
    eslintrc: icons.icon_eslint,
    eslintignore: icons.icon_eslint,
    babelrc: icons.icon_babel,
    browserslistrc: icons.icon_browserlist,

    // 新增 - 编程语言
    h: icons.icon_h,
    hpp: icons.icon_hpp,
    hxx: icons.icon_hpp,
    m: icons.icon_objective_c,
    mm: icons.icon_objective_cpp,
    v: icons.icon_verilog,
    vh: icons.icon_verilog,
    vhd: icons.icon_verilog,
    vhdl: icons.icon_verilog,
    sol: icons.icon_solidity,
    cairo: icons.icon_cairo,
    nix: icons.icon_nix,
    raku: icons.icon_perl,
    tcl: icons.icon_tcl,
    vim: icons.icon_vim,
    ahk: icons.icon_autohotkey,

    // 新增 - 数据格式
    csv: icons.icon_table,
    tsv: icons.icon_table,
    ini: icons.icon_settings,
    cfg: icons.icon_settings,
    conf: icons.icon_settings,
    properties: icons.icon_settings,
    hjson: icons.icon_hjson,

    // 新增 - 科学计算
    ipynb: icons.icon_jupyter,
    nb: icons.icon_mathematica,
    mat: icons.icon_matlab,
    rdata: icons.icon_r,

    // 新增 - DevOps
    tf: icons.icon_terraform,
    tfvars: icons.icon_terraform,
    hcl: icons.icon_hcl,
    k8s: icons.icon_kubernetes,

    // 新增 - 数据库
    mongodb: icons.icon_database,
    redis: icons.icon_database,

    // 新增 - 文档格式
    rst: icons.icon_readme,
    org: icons.icon_todo,
    txt: icons.icon_document,
    rtf: icons.icon_document,
    epub: icons.icon_epub,

    // 新增 - 其他
    http: icons.icon_http,
    rest: icons.icon_http,
    snap: icons.icon_jest,
    spec: icons.icon_test_ts,
    test: icons.icon_test_ts,
    feature: icons.icon_cucumber,
    stories: icons.icon_storybook,
    story: icons.icon_storybook,
  };

  return iconMap[ext] || icons.icon_file;
}

/**
 * 根据文件夹名称获取图标 SVG
 */
export function getFolderIcon(folderName: string, isOpen: boolean = false): string {
  const name = folderName.toLowerCase();

  // 特殊文件夹映射
  const specialFolders: Record<string, string> = {
    src: icons.icon_folder_src,
    test: icons.icon_folder_test,
    tests: icons.icon_folder_test,
    __tests__: icons.icon_folder_test,
    config: icons.icon_folder_config,
    configs: icons.icon_folder_config,
    configuration: icons.icon_folder_config,
    docs: icons.icon_folder_docs,
    doc: icons.icon_folder_docs,
    documentation: icons.icon_folder_docs,
    public: icons.icon_folder_public,
    node_modules: icons.icon_folder_node,
    '.git': icons.icon_folder_git,
    api: icons.icon_folder_api,
    apis: icons.icon_folder_api,
    lib: icons.icon_folder_lib,
    libs: icons.icon_folder_lib,
    library: icons.icon_folder_lib,
    libraries: icons.icon_folder_lib,
    // 新增文件夹图标
    components: icons.icon_folder_components,
    component: icons.icon_folder_components,
    assets: icons.icon_folder_images,
    images: icons.icon_folder_images,
    img: icons.icon_folder_images,
    icons: icons.icon_folder_images,
    utils: icons.icon_folder_utils,
    util: icons.icon_folder_utils,
    utilities: icons.icon_folder_utils,
    helpers: icons.icon_folder_helper,
    helper: icons.icon_folder_helper,
    hooks: icons.icon_folder_hook,
    hook: icons.icon_folder_hook,
    styles: icons.icon_folder_css,
    style: icons.icon_folder_css,
    css: icons.icon_folder_css,
    scss: icons.icon_folder_sass,
    sass: icons.icon_folder_sass,
    views: icons.icon_folder_views,
    view: icons.icon_folder_views,
    pages: icons.icon_folder_views,
    page: icons.icon_folder_views,
    layouts: icons.icon_folder_layout,
    layout: icons.icon_folder_layout,
    routes: icons.icon_folder_routes,
    router: icons.icon_folder_routes,
    controllers: icons.icon_folder_controller,
    controller: icons.icon_folder_controller,
    models: icons.icon_folder_database,
    model: icons.icon_folder_database,
    services: icons.icon_folder_server,
    service: icons.icon_folder_server,
    middleware: icons.icon_folder_middleware,
    middlewares: icons.icon_folder_middleware,
    types: icons.icon_folder_typescript,
    typings: icons.icon_folder_typescript,
    '@types': icons.icon_folder_typescript,
    interfaces: icons.icon_folder_interface,
    interface: icons.icon_folder_interface,
    scripts: icons.icon_folder_scripts,
    script: icons.icon_folder_scripts,
    build: icons.icon_folder_dist,
    dist: icons.icon_folder_dist,
    out: icons.icon_folder_dist,
    output: icons.icon_folder_dist,
    bin: icons.icon_folder_dist,
    vendor: icons.icon_folder_lib,
    vendors: icons.icon_folder_lib,
    packages: icons.icon_folder_packages,
    '.github': icons.icon_folder_github,
    '.vscode': icons.icon_folder_vscode,
    '.idea': icons.icon_folder_intellij,
    android: icons.icon_folder_android,
    ios: icons.icon_folder_ios,
    docker: icons.icon_folder_docker,
    kubernetes: icons.icon_folder_kubernetes,
    k8s: icons.icon_folder_kubernetes,
    terraform: icons.icon_folder_terraform,
    prisma: icons.icon_folder_prisma,
    graphql: icons.icon_folder_graphql,
    redux: icons.icon_folder_redux_store,
    store: icons.icon_folder_store,
    stores: icons.icon_folder_store,
    state: icons.icon_folder_store,
    i18n: icons.icon_folder_i18n,
    locales: icons.icon_folder_i18n,
    locale: icons.icon_folder_i18n,
    translations: icons.icon_folder_i18n,
    mocks: icons.icon_folder_mock,
    mock: icons.icon_folder_mock,
    __mocks__: icons.icon_folder_mock,
    fixtures: icons.icon_folder_mock,
    temp: icons.icon_folder_temp,
    tmp: icons.icon_folder_temp,
    cache: icons.icon_folder_temp,
    logs: icons.icon_folder_log,
    log: icons.icon_folder_log,
    '.claude': icons.icon_folder_claude,
    claude: icons.icon_folder_claude,
  };

  // 打开状态的通用文件夹
  if (isOpen && !specialFolders[name]) {
    return icons.icon_folder_open;
  }

  return specialFolders[name] || icons.icon_folder;
}

/**
 * 获取工具/框架相关的图标 SVG
 */
export function getToolIcon(toolName: string): string {
  const tools: Record<string, string> = {
    // 版本控制
    git: icons.icon_git,
    github: icons.icon_git,
    gitlab: icons.icon_gitlab,
    bitbucket: icons.icon_bitbucket,

    // 容器与运维
    docker: icons.icon_docker,
    kubernetes: icons.icon_kubernetes,
    k8s: icons.icon_kubernetes,
    terraform: icons.icon_terraform,
    helm: icons.icon_helm,

    // 运行时
    node: icons.icon_nodejs,
    nodejs: icons.icon_nodejs,
    deno: icons.icon_deno,
    bun: icons.icon_bun,

    // 包管理
    npm: icons.icon_npm,
    yarn: icons.icon_yarn,
    pnpm: icons.icon_pnpm,
    pip: icons.icon_python,
    cargo: icons.icon_rust,
    maven: icons.icon_maven,
    gradle: icons.icon_gradle,

    // 前端框架
    react: icons.icon_react,
    vue: icons.icon_vue,
    angular: icons.icon_angular,
    svelte: icons.icon_svelte,
    next: icons.icon_next,
    nuxt: icons.icon_nuxt,
    gatsby: icons.icon_gatsby,
    remix: icons.icon_remix,
    astro: icons.icon_astro,
    solid: icons.icon_file,
    qwik: icons.icon_qwik,

    // 构建工具
    webpack: icons.icon_webpack,
    vite: icons.icon_vite,
    rollup: icons.icon_rollup,
    parcel: icons.icon_parcel,
    esbuild: icons.icon_esbuild,
    swc: icons.icon_swc,
    turbo: icons.icon_turborepo,
    turborepo: icons.icon_turborepo,
    nx: icons.icon_nx,

    // 代码质量
    eslint: icons.icon_eslint,
    prettier: icons.icon_prettier,
    stylelint: icons.icon_stylelint,
    biome: icons.icon_biome,

    // 测试框架
    jest: icons.icon_jest,
    vitest: icons.icon_vitest,
    mocha: icons.icon_mocha,
    cypress: icons.icon_cypress,
    playwright: icons.icon_playwright,
    storybook: icons.icon_storybook,

    // 样式工具
    tailwind: icons.icon_tailwindcss,
    tailwindcss: icons.icon_tailwindcss,
    sass: icons.icon_sass,
    less: icons.icon_less,
    postcss: icons.icon_postcss,
    styled: icons.icon_file,

    // ORM/数据库
    prisma: icons.icon_prisma,
    drizzle: icons.icon_drizzle,
    sequelize: icons.icon_sequelize,
    mongodb: icons.icon_database,
    postgresql: icons.icon_database,
    mysql: icons.icon_database,
    redis: icons.icon_database,
    supabase: icons.icon_supabase,
    firebase: icons.icon_firebase,

    // GraphQL
    graphql: icons.icon_graphql,
    apollo: icons.icon_apollo,

    // API
    swagger: icons.icon_swagger,
    openapi: icons.icon_openapi,

    // 云服务
    azure: icons.icon_azure,
    gcp: icons.icon_gcp,
    vercel: icons.icon_vercel,
    netlify: icons.icon_netlify,
    cloudflare: icons.icon_cloudfoundry,

    // 编辑器/IDE
    vscode: icons.icon_vscode,
    intellij: icons.icon_file,
    vim: icons.icon_vim,

    // AI工具
    claude: icons.icon_claude,
    copilot: icons.icon_copilot,

    // 移动端
    reactnative: icons.icon_react,
    ionic: icons.icon_ionic,
    capacitor: icons.icon_capacitor,

    // 其他工具
    jenkins: icons.icon_jenkins,
    circleci: icons.icon_circleci,
    github_actions: icons.icon_github_actions_workflow,
  };

  return tools[toolName.toLowerCase()] || icons.icon_file;
}
