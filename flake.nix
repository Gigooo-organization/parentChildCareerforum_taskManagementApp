{
  # Vite+ (vp) と Vize はプラットフォーム別プリビルドを npm 配布しているため
  # pnpm 側で管理する。Nix が固定するのは Node と pnpm のブートストラップまで。
  #
  # pnpm の実バージョンは package.json の packageManager (12.4.2) が持つ。
  # nixpkgs の pnpm は 11.25.0 だが devEngines.onFail=download により
  # 自分で 12.4.2 を取ってきて委譲するので、ここは入口があればよい。
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
