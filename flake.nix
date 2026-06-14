{
  description = "MemPalace - Give your AI a memory";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    pyproject-nix = {
      url = "github:pyproject-nix/pyproject.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    uv2nix = {
      url = "github:pyproject-nix/uv2nix";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    pyproject-build-systems = {
      url = "github:pyproject-nix/build-system-pkgs";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.uv2nix.follows = "uv2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      nixpkgs,
      pyproject-nix,
      uv2nix,
      pyproject-build-systems,
      ...
    }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = lib.genAttrs systems;

      workspace = uv2nix.lib.workspace.loadWorkspace { workspaceRoot = ./.; };

      overlay = workspace.mkPyprojectOverlay {
        sourcePreference = "wheel";
      };

      pyprojectOverrides = final: prev: {
        chroma-hnswlib = prev.chroma-hnswlib.overrideAttrs (old: {
          nativeBuildInputs =
            (old.nativeBuildInputs or [ ])
            ++ (final.resolveBuildSystem {
              setuptools = [ ];
              pybind11 = [ ];
              numpy = [ ];
            });
        });
        autocorrect = prev.autocorrect.overrideAttrs (old: {
          nativeBuildInputs =
            (old.nativeBuildInputs or [ ])
            ++ (final.resolveBuildSystem {
              setuptools = [ ];
            });
        });
      };

      mkPythonSet =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        (pkgs.callPackage pyproject-nix.build.packages {
          python = pkgs.python312;
        }).overrideScope
          (
            lib.composeManyExtensions [
              pyproject-build-systems.overlays.wheel
              overlay
              pyprojectOverrides
            ]
          );
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = ((mkPythonSet system).mkVirtualEnv "mempalace-env" workspace.deps.default).overrideAttrs {
            meta.mainProgram = "mempalace";
          };

          opencode-plugin = pkgs.runCommand "mempalace-opencode-plugin" {
            passthru.agents = {
              backends = [ "opencode" ];
              opencode = {
                entrypoint = "plugin.js";
              };
            };
          } ''
            mkdir -p "$out"
            cp ${./integrations/opencode/plugin.js} "$out/plugin.js"
          '';
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          pythonSet = mkPythonSet system;
          devDeps = builtins.mapAttrs (_: builtins.filter (e: !builtins.elem e [ "dml" "gpu" "coreml" ])) workspace.deps.all;
          virtualenv = pythonSet.mkVirtualEnv "mempalace-dev-env" devDeps;
        in
        {
          default = pkgs.mkShell {
            packages = [
              virtualenv
              pkgs.uv
            ];
            env = {
              UV_NO_SYNC = "1";
              UV_PYTHON = pythonSet.python.interpreter;
              UV_PYTHON_DOWNLOADS = "never";
            };
            shellHook = ''
              unset PYTHONPATH
            '';
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          opencode-plugin-test = pkgs.runCommand "opencode-plugin-test" {
            nativeBuildInputs = [ pkgs.bun ];
          } ''
            mkdir -p work
            cp ${./integrations/opencode/plugin.js} work/plugin.js
            cp ${./integrations/opencode/plugin.test.js} work/plugin.test.js
            cd work
            export HOME="$TMPDIR/bun-home"
            mkdir -p "$HOME"
            ${pkgs.bun}/bin/bun test plugin.test.js 2>&1
            touch "$out"
          '';
        }
      );
    };
}
