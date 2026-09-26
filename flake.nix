{
  description = "Devrandom governed harness evolution prototype";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/b6c98e9e6633ee64753b594ff4a5febf0367fc00";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachSystem [ "aarch64-darwin" "x86_64-linux" ] (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        node = pkgs.nodejs_24;
        pnpm = pkgs.pnpm_12;
        docker = pkgs.docker-client;
        compose = pkgs.docker-compose;
        colima = pkgs.colima;
        rustc = pkgs.rustc;
        cargo = pkgs.cargo;
        rustfmt = pkgs.rustfmt;
        clippy = pkgs.clippy;
      in
      assert node.version == "24.20.0";
      assert pnpm.version == "12.3.4";
      assert docker.version == "29.8.0";
      assert compose.version == "5.5.1";
      assert colima.version == "0.10.3";
      assert rustc.version == "1.98.1";
      assert cargo.version == "1.98.1";
      assert rustfmt.version == "1.98.1";
      assert clippy.version == "1.98.1";
      {
        devShells.default = pkgs.mkShell {
          packages = [
            compose
            docker
            node
            pnpm
            rustc
            cargo
            rustfmt
            clippy
            pkgs.git
            pkgs.just
          ]
          ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [ colima ];

          shellHook = ''
            export DEVRANDOM_NIX_SHELL=1
            export PATH="$PWD/node_modules/.bin:$PATH"
          '';
        };

        checks.toolchain =
          pkgs.runCommand "devrandom-toolchain"
            {
              nativeBuildInputs = [
                node
                pnpm
                pkgs.just
                compose
                docker
                rustc
                cargo
                rustfmt
                clippy
              ];
            }
            ''
              test "$(node --version)" = "v24.20.0"
              test "$(pnpm --version)" = "12.3.4"
              test "$(docker --version)" = "Docker version 29.8.0, build v29.8.0"
              test "$(docker-compose version --short)" = "5.5.1"
              test "$(rustc --version | cut -d' ' -f1-2)" = "rustc 1.98.1"
              test "$(cargo --version | cut -d' ' -f1-2)" = "cargo 1.98.0"
              rustfmt --version >/dev/null
              cargo clippy --version >/dev/null
              just --version >/dev/null
              touch "$out"
            '';

        formatter = pkgs.nixfmt;
      }
    );
}
