# Builds the CC GUI IntelliJ plugin distribution (.zip) inside a container.
#
# Build the image:
#   docker build -t cc-gui-build .
#
# Produce the plugin zip into ./dist on the host:
#   mkdir -p dist && docker run --rm -v "$(pwd)/dist:/out" cc-gui-build
#
# Target a different IDE (IC = IntelliJ Community [default], PC, PY, RD):
#   docker run --rm -v "$(pwd)/dist:/out" -e TARGET_IDE=PC cc-gui-build

FROM eclipse-temurin:17-jdk-jammy AS build

ENV DEBIAN_FRONTEND=noninteractive \
    GRADLE_OPTS="-Dorg.gradle.daemon=false -Dorg.gradle.welcome=never"

# Node.js 20.x + zip/unzip (zip is invoked by the packageAiBridge Gradle task).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg git zip unzip \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && node --version && npm --version && java -version

WORKDIR /workspace

# Install npm deps first so they cache independently of source changes.
COPY webview/package.json   webview/package-lock.json   webview/
COPY ai-bridge/package.json ai-bridge/package-lock.json ai-bridge/

# Use `npm install` (not `npm ci`) because the upstream lockfiles drift from
# package.json — `npm ci` aborts on any missing transitive entry, which makes
# the container build fail on a repo issue rather than a real problem.
RUN cd webview   && npm install --no-audit --no-fund
RUN cd ai-bridge && npm install --no-audit --no-fund

# Now bring in the rest of the sources. .dockerignore keeps host build/ and
# node_modules/ out so the container build is reproducible.
COPY . .

RUN chmod +x gradlew

ARG TARGET_IDE=IC
ENV TARGET_IDE=${TARGET_IDE}

# buildPlugin transitively runs buildWebview + packageAiBridge.
RUN ./gradlew --no-daemon -PtargetIde=${TARGET_IDE} clean buildPlugin

# Default entrypoint: copy the produced artifact to a bind-mounted /out.
CMD ["bash", "-lc", "mkdir -p /out && cp build/distributions/*.zip /out/ && ls -lh /out/"]
