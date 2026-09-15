{
  # Vite+ (vp) と Vize はプラットフォーム別プリビルドを npm 配布しているため
  # pnpm 側で管理する。Nix が固定するのは Node と pnpm まで。
  description = "parentChildCareerforum task management app (Vite+ / Vize / Vue)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
    in
    {
      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs_22 pkgs.pnpm ];
          };
        });
    };
}
