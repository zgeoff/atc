# Changelog

## [4.14.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.13.2...@zgeoff/atc@4.14.0) (2026-10-18)

### Features

- **geo-444:** trust a forwarded address only from a listed proxy
  ([#767](https://github.com/zgeoff/atc/issues/767))
  ([f961dc7](https://github.com/zgeoff/atc/commit/f961dc7be77d4f280d8e07997cf9161fa4929d17))

### Bug Fixes

- **geo-1240:** revive an outdated harness that ended while its imp slept
  ([#759](https://github.com/zgeoff/atc/issues/759))
  ([3a63410](https://github.com/zgeoff/atc/commit/3a634105eaeea7475f61e490c2b019777e32f193))
- **geo-1329:** rewrite the bridge mod of a session whose tap is gone
  ([#766](https://github.com/zgeoff/atc/issues/766))
  ([bd9bf2b](https://github.com/zgeoff/atc/commit/bd9bf2bdda549ff4da563f06a8c44e185347cdaf))

## [4.13.2](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.13.1...@zgeoff/atc@4.13.2) (2026-10-18)

### Bug Fixes

- **geo-1289:** keep messages across a restart and notices to one copy
  ([#755](https://github.com/zgeoff/atc/issues/755))
  ([fa8037c](https://github.com/zgeoff/atc/commit/fa8037ce3535d0ab53f9710e204b1bac38ca2ef2))

## [4.13.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.13.0...@zgeoff/atc@4.13.1) (2026-10-18)

### Bug Fixes

- **geo-1264:** spawn on a remote target without a host agent binary
  ([#740](https://github.com/zgeoff/atc/issues/740))
  ([31bbf48](https://github.com/zgeoff/atc/commit/31bbf485f7427fa6c7dd9745d74a0afd130066a2))

## [4.13.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.12.0...@zgeoff/atc@4.13.0) (2026-10-17)

### Features

- **geo-1171:** pilot the renovate preset and audit-fix workflow
  ([#696](https://github.com/zgeoff/atc/issues/696))
  ([5fea433](https://github.com/zgeoff/atc/commit/5fea43328bedeea1eade894f44cdfb8b3d4a8899))

### Bug Fixes

- **geo-1136:** shorten check-reach's daemon comment so lint:full passes
  ([#712](https://github.com/zgeoff/atc/issues/712))
  ([86cd055](https://github.com/zgeoff/atc/commit/86cd0553b56ff0c3bf65bdec595b4e73e74ab59a))
- **geo-1210:** name impz in the codex adapter's oauth secret error
  ([#707](https://github.com/zgeoff/atc/issues/707))
  ([b077179](https://github.com/zgeoff/atc/commit/b0771790b2735c20e877d0b67d3d90f33e6aea32))
- **geo-1221:** keep each unconfirmed send's thread over a daemon restart
  ([#721](https://github.com/zgeoff/atc/issues/721))
  ([0fb980c](https://github.com/zgeoff/atc/commit/0fb980c7f523759a14b315b4c832b931d0aae582))
- **geo-909:** keep a message answerable when atc misses its answer
  ([#713](https://github.com/zgeoff/atc/issues/713))
  ([644f297](https://github.com/zgeoff/atc/commit/644f2978107baa6bb915f12eb028fc78ab3635fb))
- **geo-947:** read the old thread for a send its connection dropped
  ([#714](https://github.com/zgeoff/atc/issues/714))
  ([c3988d9](https://github.com/zgeoff/atc/commit/c3988d9e555f20535daeb43c7f69f040249a061c))

### Performance Improvements

- **geo-201:** reuse impd's features and a known guest atc version
  ([#716](https://github.com/zgeoff/atc/issues/716))
  ([6b269f0](https://github.com/zgeoff/atc/commit/6b269f0adab2b18eda18c07117ec347396dff385))

## [4.12.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.11.0...@zgeoff/atc@4.12.0) (2026-10-17)

### Features

- **geo-880:** let an imp target run its harnesses without cap_sys_admin
  ([#680](https://github.com/zgeoff/atc/issues/680))
  ([f1ad6dd](https://github.com/zgeoff/atc/commit/f1ad6dda272a7234a4cfc5eb2e47f815aac0e19d))

### Bug Fixes

- **geo-1148:** keep a nested codex run from reporting as its session
  ([#673](https://github.com/zgeoff/atc/issues/673))
  ([fe5efc1](https://github.com/zgeoff/atc/commit/fe5efc110f41aebab2b4bd3239f88b25d9517329))
- **geo-1161:** pass a preload named only through type-only specifiers
  ([#679](https://github.com/zgeoff/atc/issues/679))
  ([746120c](https://github.com/zgeoff/atc/commit/746120c692be0f0badcbc33e0849a0924665cc90))
- **geo-1169:** hold an atc-bridge delivery while a response streams
  ([#689](https://github.com/zgeoff/atc/issues/689))
  ([8830117](https://github.com/zgeoff/atc/commit/88301174cb034df194ba43a8c8126fdbffaf2caf))
- **geo-1172:** retry a start whose capability check times out
  ([#688](https://github.com/zgeoff/atc/issues/688))
  ([0e40551](https://github.com/zgeoff/atc/commit/0e40551519f62b85457be5e3833b0fce92c25295))

### Performance Improvements

- **geo-201:** cut round trips from auth-binding and guest-atc
  ([#681](https://github.com/zgeoff/atc/issues/681))
  ([70c7464](https://github.com/zgeoff/atc/commit/70c7464073a1038c93e909271f4edd93090f7e94))

## [4.11.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.10.0...@zgeoff/atc@4.11.0) (2026-10-16)

### Features

- **geo-1051:** add atc backup to copy the daemon's state database
  ([#652](https://github.com/zgeoff/atc/issues/652))
  ([400260b](https://github.com/zgeoff/atc/commit/400260bd4e23960fbc89fd1286cea8f40ee60990))

### Bug Fixes

- **geo-1022:** move the codex bridge only on a session start
  ([#639](https://github.com/zgeoff/atc/issues/639))
  ([70f27e9](https://github.com/zgeoff/atc/commit/70f27e93b31327d131202aebeecaab4f0adc79cd))
- **geo-1023:** mark a choice partial when its menu read fails
  ([#640](https://github.com/zgeoff/atc/issues/640))
  ([a085359](https://github.com/zgeoff/atc/commit/a085359e3d8b396ea94d63a33e63cf8c3f8a75ba))
- **geo-1026:** hold codex sends while a thread move is pending
  ([#641](https://github.com/zgeoff/atc/issues/641))
  ([ff444f5](https://github.com/zgeoff/atc/commit/ff444f535746a2a3f60e5dabe230480ea005d004))
- **geo-1028:** wait for a typed path in the form the picker draws it
  ([#643](https://github.com/zgeoff/atc/issues/643))
  ([c24f360](https://github.com/zgeoff/atc/commit/c24f360ca9d25974e8273217e7aa5b34d4496c16))
- **geo-1030:** restore a session whose host slept as suspended
  ([#647](https://github.com/zgeoff/atc/issues/647))
  ([2e39c4f](https://github.com/zgeoff/atc/commit/2e39c4f6754d8804874e32f4b6b539747839baa6))
- **geo-912:** keep a session stopped during an adopt's restart
  ([#656](https://github.com/zgeoff/atc/issues/656))
  ([41b2e31](https://github.com/zgeoff/atc/commit/41b2e3129a03d51bf109982d3fe120a0e1115c93))

## [4.10.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.9.0...@zgeoff/atc@4.10.0) (2026-10-15)

### Features

- **geo-480:** call the impz cli and the zgeoff/impz repo
  ([#627](https://github.com/zgeoff/atc/issues/627))
  ([ee12fb0](https://github.com/zgeoff/atc/commit/ee12fb0e428f347ebd5176b3cb3993277f54a6ba))
- **geo-928:** deliver messages to codex sessions through the app server
  ([#628](https://github.com/zgeoff/atc/issues/628))
  ([c0aa5ff](https://github.com/zgeoff/atc/commit/c0aa5ff672ceb3e89766facbaf689bb8c2c7412b))
- **geo-939:** read and choose every option of a scrolled menu
  ([#631](https://github.com/zgeoff/atc/issues/631))
  ([a268494](https://github.com/zgeoff/atc/commit/a268494303fb9847dccb880fa7b147203be8da38))
- **geo-984:** skip listed host-failing tests in the pre-push tests
  ([#637](https://github.com/zgeoff/atc/issues/637))
  ([0b299ad](https://github.com/zgeoff/atc/commit/0b299ad9d3c8d13f2bd293c923987f895895cbea))

### Bug Fixes

- **geo-916:** compare importers against the real root in check:bundle
  ([#622](https://github.com/zgeoff/atc/issues/622))
  ([302e44a](https://github.com/zgeoff/atc/commit/302e44ad62593a5392e5ffa39d1f70c7028a0e87))
- **geo-940:** move the codex bridge to the thread the terminal shows
  ([#632](https://github.com/zgeoff/atc/issues/632))
  ([005fbf7](https://github.com/zgeoff/atc/commit/005fbf7854744f097eb44f3bf30ac47c78c375aa))
- **geo-941:** retry overloaded codex sends on the spawn's model
  ([#634](https://github.com/zgeoff/atc/issues/634))
  ([2a989b0](https://github.com/zgeoff/atc/commit/2a989b0cedb6ff427ed7fb4b8dbe025114a050c2))
- **geo-982:** state a scope for each member of the scoped context
  ([#635](https://github.com/zgeoff/atc/issues/635))
  ([43c6b07](https://github.com/zgeoff/atc/commit/43c6b074561f0fc50712b8bac64202e4da61bc65))

## [4.9.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.8.0...@zgeoff/atc@4.9.0) (2026-10-15)

### Features

- **geo-24:** open a remote daemon's fleet with atc --daemon
  ([#611](https://github.com/zgeoff/atc/issues/611))
  ([ff3d5d0](https://github.com/zgeoff/atc/commit/ff3d5d0690827883f34aad67bb5fb7006a92de9e))
- **geo-296:** answer each atc message with the bridge's answer tool
  ([#612](https://github.com/zgeoff/atc/issues/612))
  ([4567738](https://github.com/zgeoff/atc/commit/456773830432e8e383547d335878073dc9fe8522))
- **geo-297:** return the whole answer on message-answered events
  ([#616](https://github.com/zgeoff/atc/issues/616))
  ([1abf0fe](https://github.com/zgeoff/atc/commit/1abf0fee9fdc6c7266dd203e630ff49bc8646aad))
- **geo-50:** restart an outdated suspended harness on adopt
  ([#613](https://github.com/zgeoff/atc/issues/613))
  ([5a7c247](https://github.com/zgeoff/atc/commit/5a7c247ccfce36d87f31723df2dc777d403052f5))

### Bug Fixes

- **geo-128:** settle the edge cases of picked workspace directories
  ([#615](https://github.com/zgeoff/atc/issues/615))
  ([bb929e6](https://github.com/zgeoff/atc/commit/bb929e6e5f451f28560c875bd5f71580ea6ae2e2))
- **geo-187:** pin bun 1.4.3 and poll the ready pipe without a spawn
  ([#618](https://github.com/zgeoff/atc/issues/618))
  ([d0b5878](https://github.com/zgeoff/atc/commit/d0b58780ca025bd02806dac79bebff8e343ea46c))
- **geo-894:** keep the test suite's temp files on tmpfs in ci
  ([#605](https://github.com/zgeoff/atc/issues/605))
  ([319b513](https://github.com/zgeoff/atc/commit/319b5138cb939f97ddcef2c9a5f1ada3a1aa35aa))
- **geo-917:** run the bridge's atc commands in the root folder
  ([#619](https://github.com/zgeoff/atc/issues/619))
  ([26db9d6](https://github.com/zgeoff/atc/commit/26db9d60f2cd70d0639d8256d667b044fd904c73))

## [4.8.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.7.0...@zgeoff/atc@4.8.0) (2026-10-15)

### Features

- **geo-210:** document restarting a session through atc_session_adopt
  ([#606](https://github.com/zgeoff/atc/issues/606))
  ([f63e74f](https://github.com/zgeoff/atc/commit/f63e74f4eebeaf8d9aa1263b9e40be5b11a23544))
- **geo-36:** sign the owner in with a passkey instead of a log code
  ([#607](https://github.com/zgeoff/atc/issues/607))
  ([6568e0d](https://github.com/zgeoff/atc/commit/6568e0d18ae12e5757ccd311c62f9eca87364780))

### Bug Fixes

- **geo-32:** remove a rollback's directory past a stale relative cwd
  ([#600](https://github.com/zgeoff/atc/issues/600))
  ([44be464](https://github.com/zgeoff/atc/commit/44be46469794bae1d2bd041296c1f21f01ab4213))
- **geo-440:** state each atc tool's behaviour as the code has it
  ([#596](https://github.com/zgeoff/atc/issues/596))
  ([8af338e](https://github.com/zgeoff/atc/commit/8af338e4c60f3ea05bc2fe2fd3cbdd1a74be3729))
- **geo-879:** replay a pre-upgrade message key that held a from
  ([#601](https://github.com/zgeoff/atc/issues/601))
  ([15acd78](https://github.com/zgeoff/atc/commit/15acd78437209f7431054f83b5bfc08ef1e6d736))
- **geo-888:** serialise listing cache writes across clients
  ([#602](https://github.com/zgeoff/atc/issues/602))
  ([f7d6097](https://github.com/zgeoff/atc/commit/f7d6097973f5f4ebf7a966705fa65db1ac0b7bd4))
- **geo-892:** compare a slow enter against the menu just before it
  ([#598](https://github.com/zgeoff/atc/issues/598))
  ([9cf56f6](https://github.com/zgeoff/atc/commit/9cf56f6b2b9a9481887656cc5fb72c3f9dd09d0f))
- **geo-893:** draw the current mode again after restart consent
  ([#603](https://github.com/zgeoff/atc/issues/603))
  ([45aa84a](https://github.com/zgeoff/atc/commit/45aa84a22ffebeb105af1ff76a2a072e4765422e))
- **geo-896:** set up bun before the cloud pin pull request step
  ([#604](https://github.com/zgeoff/atc/issues/604))
  ([415ec53](https://github.com/zgeoff/atc/commit/415ec5388a089f44e993e346844a20c6a0271c7c))
- **geo-897:** let a process inside a session stream atc events
  ([#609](https://github.com/zgeoff/atc/issues/609))
  ([e3d92c6](https://github.com/zgeoff/atc/commit/e3d92c6711c77c165a66d4c47acb48d0deccdf2e))
- **geo-901:** label a local program's message local, not owner
  ([#608](https://github.com/zgeoff/atc/issues/608))
  ([05a0ea6](https://github.com/zgeoff/atc/commit/05a0ea6a4c23a60fab75b2bda6474301820df513))
- **geo-903:** swap the guest atc in by one rename, never remove it
  ([#610](https://github.com/zgeoff/atc/issues/610))
  ([5c0f749](https://github.com/zgeoff/atc/commit/5c0f749184df9e1578830a29f1f1a273735cd316))

## [4.7.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.6.0...@zgeoff/atc@4.7.0) (2026-10-14)

### Features

- **geo-179:** place an imp session's record in impd's read-only files
  ([#582](https://github.com/zgeoff/atc/issues/582))
  ([137f523](https://github.com/zgeoff/atc/commit/137f5236236f175aab9cc9009aad885dd8456af3))
- **geo-208:** show a cached repository list at once in the picker
  ([#590](https://github.com/zgeoff/atc/issues/590))
  ([9d38d65](https://github.com/zgeoff/atc/commit/9d38d653debba20593499d9e2265103f43e0d23a))
- **geo-427:** answer an agent's menu through atc_terminal_choose
  ([#591](https://github.com/zgeoff/atc/issues/591))
  ([78f8d17](https://github.com/zgeoff/atc/commit/78f8d1713170b995cf0ea00b3bf64874571a142d))
- **geo-855:** push message answers to the sending session
  ([#579](https://github.com/zgeoff/atc/issues/579))
  ([a9b091a](https://github.com/zgeoff/atc/commit/a9b091afb8b7ef6205cb031a5b04a26191430870))

### Bug Fixes

- **geo-207:** let a session forget its own sub-sessions under its pin
  ([#585](https://github.com/zgeoff/atc/issues/585))
  ([93d2a62](https://github.com/zgeoff/atc/commit/93d2a6281b01ec1cf4ac952b041f92edd5365e26))
- **geo-292:** label each message sender by who called
  ([#584](https://github.com/zgeoff/atc/issues/584))
  ([5123dbf](https://github.com/zgeoff/atc/commit/5123dbf80267c81cfe5c657557124f840ae74e48))
- **geo-333:** drop the report compatibility paths
  ([#575](https://github.com/zgeoff/atc/issues/575))
  ([c9af3e8](https://github.com/zgeoff/atc/commit/c9af3e8950028517c4bb43f7af1b6ae8cf927741))
- **geo-346:** show a refused restore and add rebind and adopt paths
  ([#586](https://github.com/zgeoff/atc/issues/586))
  ([b2d2599](https://github.com/zgeoff/atc/commit/b2d2599e4164396dea3e0a9b36c14753d985edd5))
- **geo-485:** reject a request the full outbound queue refuses
  ([#583](https://github.com/zgeoff/atc/issues/583))
  ([68b099b](https://github.com/zgeoff/atc/commit/68b099b1bca42341db418d513e021c366647ab1a))
- **geo-486:** reconnect the stdio mcp server after a daemon restart
  ([#588](https://github.com/zgeoff/atc/issues/588))
  ([88a61f9](https://github.com/zgeoff/atc/commit/88a61f93d6edb24950a6adf6543df4abee62aef7))
- **geo-487:** prune the event trail on start and on a timer
  ([#592](https://github.com/zgeoff/atc/issues/592))
  ([f085687](https://github.com/zgeoff/atc/commit/f085687a65f013d1877f1fe5bf1f0517f73fab97))
- **geo-488:** write status.json through a temporary file and a rename
  ([#587](https://github.com/zgeoff/atc/issues/587))
  ([ddfac8d](https://github.com/zgeoff/atc/commit/ddfac8d90ca142699ce6c486dd231a32b7c85212))
- **geo-489:** prompt for a restart when a reconnect meets a mismatch
  ([#594](https://github.com/zgeoff/atc/issues/594))
  ([7961ed3](https://github.com/zgeoff/atc/commit/7961ed3d4d6318609139b81efeb5bed5214c35ba))
- **geo-490:** bind the daemon's unix sockets owner-only
  ([#581](https://github.com/zgeoff/atc/issues/581))
  ([5503ed5](https://github.com/zgeoff/atc/commit/5503ed53f55fddee90aa97c2b8df93962d39a8ab))
- **geo-562:** cap the automatic restore's boot wait by default
  ([#593](https://github.com/zgeoff/atc/issues/593))
  ([ddebb2e](https://github.com/zgeoff/atc/commit/ddebb2e580121eb2166ab078107229c814c3fc97))
- **geo-564:** bind a local caller's session from the kernel's peer pid
  ([#580](https://github.com/zgeoff/atc/issues/580))
  ([c3a7c41](https://github.com/zgeoff/atc/commit/c3a7c412c29d2f241d30d1ec03003553b9749393))
- **geo-875:** queue the answer notice in the settling statement
  ([#589](https://github.com/zgeoff/atc/issues/589))
  ([532fa11](https://github.com/zgeoff/atc/commit/532fa1159ede4e74119dafd53e258c8e1b3a3187))
- **geo-881:** add gateway id rules for session.adopt and auth.rebind
  ([#595](https://github.com/zgeoff/atc/issues/595))
  ([996ffc1](https://github.com/zgeoff/atc/commit/996ffc15ce712660f815cd2e5e34d607441d6d15))

## [4.6.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.5.0...@zgeoff/atc@4.6.0) (2026-10-13)

### Features

- **geo-443:** emit security events for gateway sign-in
  ([#561](https://github.com/zgeoff/atc/issues/561))
  ([888b5b3](https://github.com/zgeoff/atc/commit/888b5b3e135b01cbb3d97ba08aabbb9058ccbfab))

### Bug Fixes

- **geo-291:** report a rename skipped for an agent-set name
  ([#568](https://github.com/zgeoff/atc/issues/568))
  ([c34948e](https://github.com/zgeoff/atc/commit/c34948ebb6b8ec5bda0112d82592ca6273b4d385))
- **geo-293:** describe a message to a restoring session as queued
  ([#566](https://github.com/zgeoff/atc/issues/566))
  ([3457851](https://github.com/zgeoff/atc/commit/345785116f3b407feda632c3f6463cd86bef5f73))
- **geo-295:** refuse a resume command a session cannot use outside atc
  ([#570](https://github.com/zgeoff/atc/issues/570))
  ([3b46ed1](https://github.com/zgeoff/atc/commit/3b46ed1e1f473334d689e0bfd5d56ffa8e909911))
- **geo-759:** gzip the atc binary copied into an imp
  ([#563](https://github.com/zgeoff/atc/issues/563))
  ([b1c5f8a](https://github.com/zgeoff/atc/commit/b1c5f8a8a1f30c80b0703af18a4cd613acc6aa4d))
- **geo-786:** list and retry a refused restore of a session
  ([#560](https://github.com/zgeoff/atc/issues/560))
  ([6732508](https://github.com/zgeoff/atc/commit/6732508dec5ce0f939332777c5bb88eb18451993))
- **geo-804:** give a tool's claude cli the broker sign-in on an imp
  ([#565](https://github.com/zgeoff/atc/issues/565))
  ([f3cb875](https://github.com/zgeoff/atc/commit/f3cb875dd537bb365aedc746d0537ecc519ee29e))
- **geo-807:** count a headless turn as live on a later restore
  ([#571](https://github.com/zgeoff/atc/issues/571))
  ([445a361](https://github.com/zgeoff/atc/commit/445a3617b887cde9d6c8b5d3b07b6d6861b8d85e))
- **geo-808:** keep a live fleet row that another target resumes
  ([#572](https://github.com/zgeoff/atc/issues/572))
  ([017a1ec](https://github.com/zgeoff/atc/commit/017a1ecde95db2c9716903ada59b788822127870))
- **geo-811:** skip a queued session whose headless turn starts
  ([#573](https://github.com/zgeoff/atc/issues/573))
  ([b7f0659](https://github.com/zgeoff/atc/commit/b7f0659b29c111b8b57d0201997b92acebca6b69))
- **geo-814:** keep one fleet row when a local spawn resumes a legacy row
  ([#574](https://github.com/zgeoff/atc/issues/574))
  ([5f4c4fe](https://github.com/zgeoff/atc/commit/5f4c4fe973d7844b638a71ce178a8c7b19cbaaf1))

## [4.5.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.4.0...@zgeoff/atc@4.5.0) (2026-10-13)

### Features

- **geo-348:** bind a claude placeholder to a non-anthropic profile
  ([#556](https://github.com/zgeoff/atc/issues/556))
  ([99e894a](https://github.com/zgeoff/atc/commit/99e894a514bfa9fe69164a43ac022bb09db15868))
- **geo-388:** detach a sub-session from its parent
  ([#557](https://github.com/zgeoff/atc/issues/557))
  ([1466fc9](https://github.com/zgeoff/atc/commit/1466fc9498ab466ee48e8ee4343ed9175406e9b5))

### Bug Fixes

- **geo-764:** close each bridge connection once the guest ends it
  ([#558](https://github.com/zgeoff/atc/issues/558))
  ([66750c4](https://github.com/zgeoff/atc/commit/66750c476809eaa902d72a9b2190de09dac890d4))

## [4.4.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.3.0...@zgeoff/atc@4.4.0) (2026-10-13)

### Features

- **geo-481:** sign in the codex cli a claude session runs on an imp
  ([#553](https://github.com/zgeoff/atc/issues/553))
  ([c201efb](https://github.com/zgeoff/atc/commit/c201efb99f1c1fb69f61d4219ca9bba079f784a0))

### Bug Fixes

- **geo-748:** mark delivered messages unanswered on session exit
  ([#551](https://github.com/zgeoff/atc/issues/551))
  ([066b348](https://github.com/zgeoff/atc/commit/066b34877521152dab1d2c886bea6cc2f63c6963))
- **geo-749:** keep queued messages after another turn fails
  ([#555](https://github.com/zgeoff/atc/issues/555))
  ([25b9e4a](https://github.com/zgeoff/atc/commit/25b9e4a51a36e985f55bb36c5df02decd4620f13))
- **geo-753:** listen again when impd fails a pending destroy
  ([#552](https://github.com/zgeoff/atc/issues/552))
  ([5e7c94d](https://github.com/zgeoff/atc/commit/5e7c94dd0623070625aa2e6826f4d55597d3c128))

## [4.3.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.2.0...@zgeoff/atc@4.3.0) (2026-10-13)

### Features

- **geo-441:** rebind a changed auth selection on opted-in imp targets
  ([#545](https://github.com/zgeoff/atc/issues/545))
  ([0dd3ce3](https://github.com/zgeoff/atc/commit/0dd3ce3e5895368af48c58c56f9ca2c50ace6abd))

### Bug Fixes

- **geo-290:** mark a message unanswered when its turn ends without an answer
  ([#548](https://github.com/zgeoff/atc/issues/548))
  ([fbb1fa6](https://github.com/zgeoff/atc/commit/fbb1fa6e4fb248e07fcd51abab2f4aac12cad8f1))
- **geo-347:** start each local session in a systemd scope of its own
  ([#549](https://github.com/zgeoff/atc/issues/549))
  ([9c48a4a](https://github.com/zgeoff/atc/commit/9c48a4a4c7696969c1943672ee20e3e36addcb11))
- **geo-554:** wait for every thread of a stopped daemon to exit
  ([#532](https://github.com/zgeoff/atc/issues/532))
  ([a7fec72](https://github.com/zgeoff/atc/commit/a7fec7250870c6ee39cc687d005391aea3278bbc))
- **geo-732:** listen again when impd ends an imp session's hook forward
  ([#546](https://github.com/zgeoff/atc/issues/546))
  ([4a59ad8](https://github.com/zgeoff/atc/commit/4a59ad87fb050fbe2e5835fe3ac746029298b47c))
- **geo-734:** keep each harness's launch auth revision across a restore
  ([#547](https://github.com/zgeoff/atc/issues/547))
  ([63d0460](https://github.com/zgeoff/atc/commit/63d0460520c73b35e5c662429832a7566f9b27de))
- **geo-739:** open no hook forward once the harness has ended
  ([#550](https://github.com/zgeoff/atc/issues/550))
  ([2f278d5](https://github.com/zgeoff/atc/commit/2f278d5eaa3770be987004ec869122087d3e20df))

## [4.2.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.1.0...@zgeoff/atc@4.2.0) (2026-10-11)

### Features

- **geo-406:** give each session a scratch folder, skip the read offer
  ([#500](https://github.com/zgeoff/atc/issues/500))
  ([1950266](https://github.com/zgeoff/atc/commit/1950266afeeb56e221c9cfe37481140d5a5effda))

## [4.1.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@4.0.0...@zgeoff/atc@4.1.0) (2026-10-11)

### Features

- **geo-450:** pair a brokered gateway with an x-api-key placeholder
  ([#502](https://github.com/zgeoff/atc/issues/502))
  ([ee4a197](https://github.com/zgeoff/atc/commit/ee4a19730a4efbb7f1385101df7ec26f88ed83b8))

## [4.0.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.11.2...@zgeoff/atc@4.0.0) (2026-10-10)

### ⚠ BREAKING CHANGES

- **geo-87:** the SessionReport event is SessionNote, the report event kind is note, report.get is
  note.get, atc report note and atc report answered are atc note and atc answer, and the accepted
  message status is queued.

### Features

- **geo-87:** rename and redescribe the atc mcp tools and their vocabulary
  ([#494](https://github.com/zgeoff/atc/issues/494))
  ([88abcbd](https://github.com/zgeoff/atc/commit/88abcbd665165debe818caf9510070bcdad7c342))

## [3.11.2](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.11.1...@zgeoff/atc@3.11.2) (2026-10-10)

### Bug Fixes

- **geo-289:** refuse typed input while a permission prompt waits
  ([#492](https://github.com/zgeoff/atc/issues/492))
  ([ef965c5](https://github.com/zgeoff/atc/commit/ef965c5755fbaff70ab010e0f62b20c9103a9318))

## [3.11.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.11.0...@zgeoff/atc@3.11.1) (2026-10-10)

### Bug Fixes

- **geo-189:** fail restart at once on a row whose agent is gone
  ([#491](https://github.com/zgeoff/atc/issues/491))
  ([80f9260](https://github.com/zgeoff/atc/commit/80f9260d382a9c7a4e9a14cb07d3b792dd37d8fe))

## [3.11.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.10.3...@zgeoff/atc@3.11.0) (2026-10-10)

### Features

- **geo-211:** scope the pre-push hook to the branch
  ([#489](https://github.com/zgeoff/atc/issues/489))
  ([d936d05](https://github.com/zgeoff/atc/commit/d936d0516ac7ebdbbd3288cea814b7f2ec4c7c10))

## [3.10.3](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.10.2...@zgeoff/atc@3.10.3) (2026-10-10)

### Bug Fixes

- **geo-209:** give imp workspaces the host's git identity
  ([#485](https://github.com/zgeoff/atc/issues/485))
  ([33982fd](https://github.com/zgeoff/atc/commit/33982fdf6a0a9989427e90ee4ed5da4f50ba695b))

## [3.10.2](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.10.1...@zgeoff/atc@3.10.2) (2026-10-09)

### Bug Fixes

- **geo-205:** keep cloud sessions usable when the target image changes
  ([0b05993](https://github.com/zgeoff/atc/commit/0b059930fe8eed89012e5919661c02b1b67b2c5b))
- **geo-206:** wait for the managed daemon instead of starting one
  ([af66137](https://github.com/zgeoff/atc/commit/af66137f9cf4ef67cff3d782edf5295619226fc1))

## [3.10.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.10.0...@zgeoff/atc@3.10.1) (2026-10-09)

### Bug Fixes

- **geo-85:** guard local spawns while a rollback removes a checkout
  ([#477](https://github.com/zgeoff/atc/issues/477))
  ([4c59487](https://github.com/zgeoff/atc/commit/4c594872f1e64836772bf813037fa106883ec15f))

## [3.10.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.9.4...@zgeoff/atc@3.10.0) (2026-10-09)

### Features

- **geo-200:** clone git workspaces inside the imp
  ([#475](https://github.com/zgeoff/atc/issues/475))
  ([ab2f3bb](https://github.com/zgeoff/atc/commit/ab2f3bbaaed20d779fcd0b43cb6eb3953613d6c5))

## [3.9.4](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.9.3...@zgeoff/atc@3.9.4) (2026-10-08)

### Bug Fixes

- **geo-28:** bound the wait for git's output after git exits
  ([#473](https://github.com/zgeoff/atc/issues/473))
  ([03237d5](https://github.com/zgeoff/atc/commit/03237d55d57e929621b3eb28c36cb34c1ce27d62))

## [3.9.3](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.9.2...@zgeoff/atc@3.9.3) (2026-10-08)

### Bug Fixes

- **geo-28:** end an overflowing answer's connection and name a stalled git
  ([#465](https://github.com/zgeoff/atc/issues/465))
  ([dba2fc4](https://github.com/zgeoff/atc/commit/dba2fc413beb536850008215b3ff8b5a9ba2b5a4))

## [3.9.2](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.9.1...@zgeoff/atc@3.9.2) (2026-10-08)

### Bug Fixes

- **config:** link the first-run config into place whole
  ([#467](https://github.com/zgeoff/atc/issues/467))
  ([9c4a23e](https://github.com/zgeoff/atc/commit/9c4a23e1101ae546b6ed2af014c1717a87ea7911))

## [3.9.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.9.0...@zgeoff/atc@3.9.1) (2026-10-08)

### Bug Fixes

- **geo-164:** keep dyld variables for a harness at a path holding =
  ([#464](https://github.com/zgeoff/atc/issues/464))
  ([1d76506](https://github.com/zgeoff/atc/commit/1d76506802dbb218897211f0ab0fa8f8c7a13585))

### Performance Improvements

- **geo-193:** time imp spawn steps and combine three guest checks
  ([#466](https://github.com/zgeoff/atc/issues/466))
  ([1e7b6a9](https://github.com/zgeoff/atc/commit/1e7b6a995e48ed9123ceb98d0b28a56c9ce516c9))

## [3.9.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.8.1...@zgeoff/atc@3.9.0) (2026-10-08)

### Features

- **geo-170:** let the gateway and mcp http servers listen on port 0
  ([#459](https://github.com/zgeoff/atc/issues/459))
  ([6b39b68](https://github.com/zgeoff/atc/commit/6b39b684f1fc21304b4fa88decd96a1e8a9706cf))

## [3.8.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.8.0...@zgeoff/atc@3.8.1) (2026-10-08)

### Bug Fixes

- **geo-177:** paste a codex slash command name apart from its argument
  ([#456](https://github.com/zgeoff/atc/issues/456))
  ([4e99060](https://github.com/zgeoff/atc/commit/4e99060f7b97dbac86b7aaeb201c6dbacf288769))

## [3.8.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.7.0...@zgeoff/atc@3.8.0) (2026-10-08)

### Features

- **geo-194:** copy atc into an imp only when the image's differs
  ([#454](https://github.com/zgeoff/atc/issues/454))
  ([a62a0bf](https://github.com/zgeoff/atc/commit/a62a0bfd93dc0dd2c6e572a84eaee2ab2a203f8a))

## [3.7.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.6.2...@zgeoff/atc@3.7.0) (2026-10-08)

### Features

- **geo-192:** gzip the workspace upload to imps ([#452](https://github.com/zgeoff/atc/issues/452))
  ([5c5a638](https://github.com/zgeoff/atc/commit/5c5a638872334a2d8b9b09c2667ea0da9d851163))

## [3.6.2](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.6.1...@zgeoff/atc@3.6.2) (2026-10-08)

### Bug Fixes

- **geo-184:** compile binaries to bytecode so hooks start fast
  ([#449](https://github.com/zgeoff/atc/issues/449))
  ([7adcc7d](https://github.com/zgeoff/atc/commit/7adcc7d3d4d17946ba70281bf6f01a6b71791e36))

## [3.6.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.6.0...@zgeoff/atc@3.6.1) (2026-10-08)

### Bug Fixes

- **geo-183:** start knip's tsconfig search inside the working directory
  ([#443](https://github.com/zgeoff/atc/issues/443))
  ([c0ec7c7](https://github.com/zgeoff/atc/commit/c0ec7c7584c668c92f38589fde8af050f3cc0b74))

## [3.6.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.5.0...@zgeoff/atc@3.6.0) (2026-10-08)

### Features

- **geo-113:** let one gateway entry start locally and on imps
  ([#438](https://github.com/zgeoff/atc/issues/438))
  ([cee4eb5](https://github.com/zgeoff/atc/commit/cee4eb51cf67823708701cd4df8d243cc3a13377))

## [3.5.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.4.2...@zgeoff/atc@3.5.0) (2026-10-08)

### Features

- **geo-158:** publish a session record with the scope a session may touch
  ([#434](https://github.com/zgeoff/atc/issues/434))
  ([ce10710](https://github.com/zgeoff/atc/commit/ce107100453ad2f82aef59bfe62c3502cfb85c30))

## [3.4.2](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.4.1...@zgeoff/atc@3.4.2) (2026-10-08)

### Bug Fixes

- **geo-175:** type a slash command name on claude and paste only its argument
  ([#426](https://github.com/zgeoff/atc/issues/426))
  ([b0a3f3a](https://github.com/zgeoff/atc/commit/b0a3f3aed9427412cc9d339dcd3b66ebf2c86a0c))

## [3.4.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.4.0...@zgeoff/atc@3.4.1) (2026-10-08)

### Bug Fixes

- **geo-171:** run each codex session without the shared server
  ([#414](https://github.com/zgeoff/atc/issues/414))
  ([e249a03](https://github.com/zgeoff/atc/commit/e249a038caa5fd86221616c67be0aeea2b3739da))

## [3.4.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.3.1...@zgeoff/atc@3.4.0) (2026-10-07)

### Features

- **geo-48:** make the session manager, daemon and store disposable
  ([#400](https://github.com/zgeoff/atc/issues/400))
  ([ec06039](https://github.com/zgeoff/atc/commit/ec06039ff754aa17f05f47411d41edef0f648d1a))

## [3.3.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.3.0...@zgeoff/atc@3.3.1) (2026-10-07)

### Bug Fixes

- **daemon:** keep the last fleet verdict at the restore deadline
  ([#369](https://github.com/zgeoff/atc/issues/369))
  ([b87af82](https://github.com/zgeoff/atc/commit/b87af82af74991c7dfbba2b21334a9f59e8d7aad))

## [3.3.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.2.0...@zgeoff/atc@3.3.0) (2026-10-07)

### Features

- **daemon:** add atc daemon restart ([#359](https://github.com/zgeoff/atc/issues/359))
  ([2879ff8](https://github.com/zgeoff/atc/commit/2879ff8a7c6a99b35ad94627abec099029ece39c))

## [3.2.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.1.1...@zgeoff/atc@3.2.0) (2026-10-07)

### Features

- **geo-147:** check pinned and live in the daemon step that forgets
  ([#355](https://github.com/zgeoff/atc/issues/355))
  ([d7a79c0](https://github.com/zgeoff/atc/commit/d7a79c0ba9c3b570f4bfcf778d74d645c0fa5f18))

### Bug Fixes

- **geo-86:** stop local pty sessions inheriting the startup environment
  ([#354](https://github.com/zgeoff/atc/issues/354))
  ([82d8252](https://github.com/zgeoff/atc/commit/82d82524459d70e90dd1eafda0ea3475444e0330))

## [3.1.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.1.0...@zgeoff/atc@3.1.1) (2026-10-07)

### Bug Fixes

- **daemon:** restore the fleet past a row that cannot be restored
  ([#351](https://github.com/zgeoff/atc/issues/351))
  ([74d9943](https://github.com/zgeoff/atc/commit/74d99431c91f6e731c4200b9fd90293d5c562ffb))

## [3.1.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@3.0.0...@zgeoff/atc@3.1.0) (2026-10-07)

### Features

- **geo-121:** sign codex in on imps through impd's oauth secret
  ([#348](https://github.com/zgeoff/atc/issues/348))
  ([0581b51](https://github.com/zgeoff/atc/commit/0581b5117815bea0f35333b12ea13fe1902073d9))

## [3.0.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.42.0...@zgeoff/atc@3.0.0) (2026-10-07)

### ⚠ BREAKING CHANGES

- **config:** config.json is organised around the `agents` map. The per-harness keys (claudeBin,
  claudeArgs, grokBin, grokArgs, codexBin, codexArgs, claudeAuth, gateways) are deprecated, a file
  that sets both `agents` and an old key does not load, and `resumeInterruptedTurns` is gone. Run
  `atc config migrate --write` to move an old config.

### Documentation

- **config:** mark the agents config map as a breaking change
  ([#347](https://github.com/zgeoff/atc/issues/347))
  ([3b33ce1](https://github.com/zgeoff/atc/commit/3b33ce1b17342561bc43d5cbc6851719b8e3280c))

## [2.42.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.41.0...@zgeoff/atc@2.42.0) (2026-10-07)

### Features

- **geo-133:** add the atc_session_forget MCP tool
  ([#345](https://github.com/zgeoff/atc/issues/345))
  ([921a015](https://github.com/zgeoff/atc/commit/921a015e4d88cca5860380adb715dc009c193594))

## [2.41.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.40.0...@zgeoff/atc@2.41.0) (2026-10-07)

### Features

- **geo-120:** set a profile's variables in brokered imp sessions
  ([#342](https://github.com/zgeoff/atc/issues/342))
  ([cbb4b06](https://github.com/zgeoff/atc/commit/cbb4b0618609607257c298502d1112a1a51594f0))
- **geo-122:** let a brokered gateway carry tool placeholders
  ([#341](https://github.com/zgeoff/atc/issues/341))
  ([4d1307b](https://github.com/zgeoff/atc/commit/4d1307bbf73a42e0f93daf9263b243f3dff6a615))

## [2.40.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.39.0...@zgeoff/atc@2.40.0) (2026-10-07)

### Features

- **geo-132:** restore the fleet after a daemon restart
  ([#339](https://github.com/zgeoff/atc/issues/339))
  ([52af732](https://github.com/zgeoff/atc/commit/52af7326b902e5b6de0531e02685e3d7ed0d600a))

## [2.39.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.38.0...@zgeoff/atc@2.39.0) (2026-10-06)

### Features

- **geo-127:** refuse brokered claude when clone settings override auth
  ([#336](https://github.com/zgeoff/atc/issues/336))
  ([2ef7cae](https://github.com/zgeoff/atc/commit/2ef7cae3b9445416436ed9d8841f993bed26a84d))

## [2.38.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.37.0...@zgeoff/atc@2.38.0) (2026-10-06)

### Features

- **geo-74:** broker mcp servers and approve trusted clone servers
  ([#332](https://github.com/zgeoff/atc/issues/332))
  ([30841aa](https://github.com/zgeoff/atc/commit/30841aa76df0f9628b8c6dda5a00be56b2c25846))

## [2.37.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.36.1...@zgeoff/atc@2.37.0) (2026-10-06)

### Features

- **config:** register agents in one agents map ([#328](https://github.com/zgeoff/atc/issues/328))
  ([c229de1](https://github.com/zgeoff/atc/commit/c229de1c8639e7d4a58d92afebbf9871eb81a93f))

## [2.36.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.36.0...@zgeoff/atc@2.36.1) (2026-10-06)

### Bug Fixes

- **deps:** pin the mcp sdk past its oauth advisory
  ([#331](https://github.com/zgeoff/atc/issues/331))
  ([048a911](https://github.com/zgeoff/atc/commit/048a911e0daee0584cee2b3aee3426b1e16e2534))

## [2.36.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.35.0...@zgeoff/atc@2.36.0) (2026-10-06)

### Features

- **geo-129:** resume turns a daemon restart interrupted
  ([#327](https://github.com/zgeoff/atc/issues/327))
  ([75ef36a](https://github.com/zgeoff/atc/commit/75ef36a964400d5289f77e29ad47054074445992))

## [2.35.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.34.0...@zgeoff/atc@2.35.0) (2026-10-06)

### Features

- **geo-110:** ship the claude config bundle to imp sessions
  ([#326](https://github.com/zgeoff/atc/issues/326))
  ([6b5510a](https://github.com/zgeoff/atc/commit/6b5510acd4ba88c12228191ca4be65708fba00af))

## [2.34.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.33.0...@zgeoff/atc@2.34.0) (2026-10-06)

### Features

- **geo-108:** pick the clone destination when a git spawn gives none
  ([#323](https://github.com/zgeoff/atc/issues/323))
  ([4cfe284](https://github.com/zgeoff/atc/commit/4cfe28411bcc98897920789d46c0ffda21ae7aa9))

## [2.33.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.32.1...@zgeoff/atc@2.33.0) (2026-10-06)

### Features

- **geo-109:** sign claude in on imps through the broker
  ([#321](https://github.com/zgeoff/atc/issues/321))
  ([1b22fcc](https://github.com/zgeoff/atc/commit/1b22fcc487a3371bfc10816e235c0062d21bd774))

## [2.32.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.32.0...@zgeoff/atc@2.32.1) (2026-10-06)

### Bug Fixes

- **geo-117:** let atc mcp --http wait for a managed daemon
  ([#320](https://github.com/zgeoff/atc/issues/320))
  ([5d46b51](https://github.com/zgeoff/atc/commit/5d46b517111ecba5a849ff29cd4d15fe5b4fd693))

## [2.32.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.31.1...@zgeoff/atc@2.32.0) (2026-10-06)

### Features

- **geo-115:** trust fresh clones on local launches
  ([#314](https://github.com/zgeoff/atc/issues/314))
  ([d0f4759](https://github.com/zgeoff/atc/commit/d0f4759277f454467290002f2b4057933e64b966))

## [2.31.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.31.0...@zgeoff/atc@2.31.1) (2026-10-06)

### Bug Fixes

- **geo-84:** paste and then submit a line to claude sessions
  ([#313](https://github.com/zgeoff/atc/issues/313))
  ([39e8b7a](https://github.com/zgeoff/atc/commit/39e8b7aa34533b2c9091a42ea5eb47d1f9714f52))

## [2.31.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.30.1...@zgeoff/atc@2.31.0) (2026-10-06)

### Features

- **geo-111:** bind github secrets through the broker
  ([#312](https://github.com/zgeoff/atc/issues/312))
  ([b7fc9fd](https://github.com/zgeoff/atc/commit/b7fc9fdd47db9e8ecf5b7470deefd05bcd2bedc7))

### Bug Fixes

- **deps:** override three packages past their audit advisories
  ([#315](https://github.com/zgeoff/atc/issues/315))
  ([4a29da0](https://github.com/zgeoff/atc/commit/4a29da0eac313d35a96239468e11e33294420629))

## [2.30.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.30.0...@zgeoff/atc@2.30.1) (2026-10-05)

### Bug Fixes

- **geo-34:** give local pty sessions a usable term
  ([#302](https://github.com/zgeoff/atc/issues/302))
  ([9852b55](https://github.com/zgeoff/atc/commit/9852b5575e3c8bda415cee5846e44ae13192133b))

## [2.30.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.29.0...@zgeoff/atc@2.30.0) (2026-10-05)

### Features

- skip spawn steps with one eligible choice ([#304](https://github.com/zgeoff/atc/issues/304))
  ([d37940d](https://github.com/zgeoff/atc/commit/d37940d0855e5b4f6eafe5b7d55733f39c31bad4))

### Bug Fixes

- **#255:** bound the listener log at shutdown and port peer tests
  ([#303](https://github.com/zgeoff/atc/issues/303))
  ([9919187](https://github.com/zgeoff/atc/commit/9919187212930287b0692e62f6921772d8109897))
- **daemon:** declare an access class for every request method
  ([#301](https://github.com/zgeoff/atc/issues/301))
  ([d9f9a56](https://github.com/zgeoff/atc/commit/d9f9a56d44ae2c9e0189b21a2b98f6b73f8662fc))
- **daemon:** stop showing a live session as ended after /clear
  ([#300](https://github.com/zgeoff/atc/issues/300))
  ([af5b78f](https://github.com/zgeoff/atc/commit/af5b78f1b0d72dd7deede150b92aa14f7530bb7c))
- **daemon:** take back the host and checkout of a failed spawn
  ([#306](https://github.com/zgeoff/atc/issues/306))
  ([1749153](https://github.com/zgeoff/atc/commit/1749153b4c4f2be8ae592269aaf7cf411975d8a9))

## [2.29.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.28.0...@zgeoff/atc@2.29.0) (2026-10-05)

### Features

- show target, harness, model, lifecycle columns in session list
  ([#298](https://github.com/zgeoff/atc/issues/298))
  ([321a007](https://github.com/zgeoff/atc/commit/321a0079dbc51253a142a2b67629b435f2147eaa))

## [2.28.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.27.0...@zgeoff/atc@2.28.0) (2026-10-05)

### Features

- clone the committed head of a dirty path source ([#296](https://github.com/zgeoff/atc/issues/296))
  ([4464ec9](https://github.com/zgeoff/atc/commit/4464ec97e16c12c402838b32591b7daa41c51ad3))

## [2.27.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.26.7...@zgeoff/atc@2.27.0) (2026-10-05)

### Features

- opt in to trust for cloned imp workspaces ([#294](https://github.com/zgeoff/atc/issues/294))
  ([7aea33d](https://github.com/zgeoff/atc/commit/7aea33d978a00a88910610b2631a76ed9f28f96c))

## [2.26.7](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.26.6...@zgeoff/atc@2.26.7) (2026-10-04)

### Bug Fixes

- **#281:** preserve redacted imp refusal details ([#292](https://github.com/zgeoff/atc/issues/292))
  ([603ac71](https://github.com/zgeoff/atc/commit/603ac715c6b240ce2875f898dd14b214eda12034))

## [2.26.6](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.26.5...@zgeoff/atc@2.26.6) (2026-10-04)

### Bug Fixes

- **#273:** keep imp session names inside the session limit
  ([#290](https://github.com/zgeoff/atc/issues/290))
  ([84c81be](https://github.com/zgeoff/atc/commit/84c81be2df725c29492713555a14f3a96cc4a942))

## [2.26.5](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.26.4...@zgeoff/atc@2.26.5) (2026-10-04)

### Bug Fixes

- **#273:** unpack an imp workspace as the guest user
  ([#287](https://github.com/zgeoff/atc/issues/287))
  ([4413608](https://github.com/zgeoff/atc/commit/44136085151fdab0415ed946993e4434240eb84a))

## [2.26.4](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.26.3...@zgeoff/atc@2.26.4) (2026-10-04)

### Bug Fixes

- **#280:** stop compiled binaries loading a .env file
  ([#285](https://github.com/zgeoff/atc/issues/285))
  ([1ad5108](https://github.com/zgeoff/atc/commit/1ad51081cead256b1c4d44590f62d4efb3e8cd96))

## [2.26.3](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.26.2...@zgeoff/atc@2.26.3) (2026-10-04)

### Bug Fixes

- **#178:** send a guest command's input to impd in pieces
  ([#282](https://github.com/zgeoff/atc/issues/282))
  ([5091a23](https://github.com/zgeoff/atc/commit/5091a23ea1ba9a2dfa359d7633961858e25529e2))

## [2.26.2](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.26.1...@zgeoff/atc@2.26.2) (2026-10-04)

### Bug Fixes

- **#192:** materialize workspaces on the session host of an imp spawn
  ([#262](https://github.com/zgeoff/atc/issues/262))
  ([b154ae2](https://github.com/zgeoff/atc/commit/b154ae2652727f2c7bf8631a6a17f7b740bb14f3))

## [2.26.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.26.0...@zgeoff/atc@2.26.1) (2026-10-03)

### Bug Fixes

- **#178:** return admissions on open throws and end harnesses in order
  ([#265](https://github.com/zgeoff/atc/issues/265))
  ([63d5760](https://github.com/zgeoff/atc/commit/63d5760e66d576c366c5d30baf16f4d9c353d828))

## [2.26.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.25.0...@zgeoff/atc@2.26.0) (2026-10-03)

### Features

- **#178:** plan claude gateway guest settings for brokered auth
  ([#247](https://github.com/zgeoff/atc/issues/247))
  ([9f45685](https://github.com/zgeoff/atc/commit/9f45685d15c5d5abdb1a7ceb0a0dfcfb8f6747b2))
- **#255:** log tcp listener start and refused handshakes
  ([#257](https://github.com/zgeoff/atc/issues/257))
  ([2add867](https://github.com/zgeoff/atc/commit/2add867a8ef71c505f88c952c8894875fb70a856))

## [2.25.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.24.0...@zgeoff/atc@2.25.0) (2026-10-03)

### Features

- **#178:** bind runtime auth through the session lifecycle
  ([#249](https://github.com/zgeoff/atc/issues/249))
  ([0a48706](https://github.com/zgeoff/atc/commit/0a48706e3a95251607f4a4026a5fb07b15c43f53))

## [2.24.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.23.0...@zgeoff/atc@2.24.0) (2026-10-03)

### Features

- **#210:** package the gateway as its own release binary
  ([#245](https://github.com/zgeoff/atc/issues/245))
  ([7f043b4](https://github.com/zgeoff/atc/commit/7f043b4e51a93da8dd1c87ffc0697cc34bff5f60))

## [2.23.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.22.0...@zgeoff/atc@2.23.0) (2026-10-03)

### Features

- **#210:** route mcp tool calls through the gateway caller
  ([#231](https://github.com/zgeoff/atc/issues/231))
  ([6cce297](https://github.com/zgeoff/atc/commit/6cce297905fc139fb3677534b0de825cb11adbb1))

## [2.22.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.21.0...@zgeoff/atc@2.22.0) (2026-10-03)

### Features

- **#210:** route gateway calls across named daemons
  ([#230](https://github.com/zgeoff/atc/issues/230))
  ([e3c732a](https://github.com/zgeoff/atc/commit/e3c732ac195b591f22412cd10493126484a7ab61))

## [2.21.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.20.0...@zgeoff/atc@2.21.0) (2026-10-03)

### Features

- **#210:** serve the client protocol over an authenticated tcp listener
  ([#229](https://github.com/zgeoff/atc/issues/229))
  ([3b136a6](https://github.com/zgeoff/atc/commit/3b136a62ab2f2202dff9be7336e78c6496c30030))

## [2.20.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.19.0...@zgeoff/atc@2.20.0) (2026-10-03)

### Features

- **#178:** parse auth profiles and add the runtime auth store
  ([#242](https://github.com/zgeoff/atc/issues/242))
  ([e6c92af](https://github.com/zgeoff/atc/commit/e6c92afafd21be2c1b0c6582fb1da775c3fce87e))

## [2.19.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.18.0...@zgeoff/atc@2.19.0) (2026-10-03)

### Features

- **#192:** spawn sessions from github repositories in the picker
  ([#225](https://github.com/zgeoff/atc/issues/225))
  ([63954f0](https://github.com/zgeoff/atc/commit/63954f0d63c141a108df793221f0c9200ec675da))

## [2.18.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.17.0...@zgeoff/atc@2.18.0) (2026-10-03)

### Features

- **#192:** choose the execution target in the spawn picker
  ([#224](https://github.com/zgeoff/atc/issues/224))
  ([fe9a234](https://github.com/zgeoff/atc/commit/fe9a234989ffcde5bc5012e94fa831d7598499e9))

## [2.17.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.16.0...@zgeoff/atc@2.17.0) (2026-10-03)

### Features

- **#192:** list github repositories and probe git sources on the daemon
  ([#223](https://github.com/zgeoff/atc/issues/223))
  ([8c2a932](https://github.com/zgeoff/atc/commit/8c2a9325f68e8d0cdaa090f3bcb80aa187ce685b))

## [2.16.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.15.2...@zgeoff/atc@2.16.0) (2026-10-03)

### Features

- **#178:** add imp grant calls and the broker authority checks
  ([#232](https://github.com/zgeoff/atc/issues/232))
  ([54ef1cf](https://github.com/zgeoff/atc/commit/54ef1cf2234258ba37d33e13117a988e9ab8312f))

### Bug Fixes

- **#233:** drop hook reports from a harness nested in a session
  ([#235](https://github.com/zgeoff/atc/issues/235))
  ([6e9932a](https://github.com/zgeoff/atc/commit/6e9932ade18fec0e9a65adc1246d5469b6c239c1))

## [2.15.2](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.15.1...@zgeoff/atc@2.15.2) (2026-10-03)

### Bug Fixes

- **#206:** scope every request to the session trees a principal may reach
  ([#226](https://github.com/zgeoff/atc/issues/226))
  ([603045c](https://github.com/zgeoff/atc/commit/603045c1820445b086921ea0af37aeae82a05c76))

## [2.15.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.15.0...@zgeoff/atc@2.15.1) (2026-10-03)

### Bug Fixes

- **#180:** keep spawn uncertainty when persistence fails
  ([#219](https://github.com/zgeoff/atc/issues/219))
  ([53c5cd0](https://github.com/zgeoff/atc/commit/53c5cd05928468097a3402f2443845016cec8eec))

## [2.15.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.14.0...@zgeoff/atc@2.15.0) (2026-10-03)

### Features

- **#213:** read an imp target's token from a file
  ([#222](https://github.com/zgeoff/atc/issues/222))
  ([9e4f224](https://github.com/zgeoff/atc/commit/9e4f22446236c90e0e5f4295abada84ebe146b19))

### Bug Fixes

- **#82:** keep unrestored fleet rows on a fleet write
  ([#218](https://github.com/zgeoff/atc/issues/218))
  ([f5490bf](https://github.com/zgeoff/atc/commit/f5490bfdf5307626049c71d7b786fb2ad9806a10))

## [2.14.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.13.0...@zgeoff/atc@2.14.0) (2026-10-03)

### Features

- **#161:** read a report's full text without messaging its session
  ([#199](https://github.com/zgeoff/atc/issues/199))
  ([86f811a](https://github.com/zgeoff/atc/commit/86f811ae1a15d179c872bd4650842a32533482f1))

### Bug Fixes

- **#196:** never stop a daemon implicitly on a protocol mismatch
  ([#200](https://github.com/zgeoff/atc/issues/200))
  ([aee0e41](https://github.com/zgeoff/atc/commit/aee0e41ed75ca4ed6beba32f6a5392adcf8ad5c4))

## [2.13.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.12.0...@zgeoff/atc@2.13.0) (2026-10-03)

### Features

- **daemon:** drive imp targets through the pinned imp client
  ([#173](https://github.com/zgeoff/atc/issues/173))
  ([a4ef780](https://github.com/zgeoff/atc/commit/a4ef7805c7223c0b379c33a269b0a5adb2bf2087))
- **daemon:** materialize a spawn's workspace through its provider
  ([#175](https://github.com/zgeoff/atc/issues/175))
  ([a2c8bb2](https://github.com/zgeoff/atc/commit/a2c8bb2cc18dc18feb77cf66d7637c9857e9e165))
- **daemon:** run sessions in imps through an imp port
  ([#172](https://github.com/zgeoff/atc/issues/172))
  ([5f038ac](https://github.com/zgeoff/atc/commit/5f038ac7b7e3aa8543be8dce00c9c37fc06ae483))
- **daemon:** serve remote session messages through a session bridge
  ([#184](https://github.com/zgeoff/atc/issues/184))
  ([db51d98](https://github.com/zgeoff/atc/commit/db51d98376c17660c43504cf4ca05bb3f51598a2))
- **daemon:** sleep killed hosts and forget them with a confirm token
  ([#171](https://github.com/zgeoff/atc/issues/171))
  ([877e6da](https://github.com/zgeoff/atc/commit/877e6da5174acd2326d8b3cf53677bf4e4dba91f))

### Bug Fixes

- **#174:** submit a typed line the way each agent's tui accepts it
  ([#182](https://github.com/zgeoff/atc/issues/182))
  ([5807f22](https://github.com/zgeoff/atc/commit/5807f22fe4047e666734197ab162c92ce886e9d9))
- **ci:** merge release prs through the release app's ruleset bypass
  ([#193](https://github.com/zgeoff/atc/issues/193))
  ([164aeb7](https://github.com/zgeoff/atc/commit/164aeb72cb0a9190c50d6ff2995884d96d955419))

## [2.12.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.11.0...@zgeoff/atc@2.12.0) (2026-10-03)

### Features

- **#105:** take a model and effort on session spawns
  ([#146](https://github.com/zgeoff/atc/issues/146))
  ([cbba345](https://github.com/zgeoff/atc/commit/cbba34591de5d1cb75261fad2aed64b314d15e1b))
- **daemon:** give the daemon a persisted identity and own its rows
  ([#154](https://github.com/zgeoff/atc/issues/154))
  ([c6eb172](https://github.com/zgeoff/atc/commit/c6eb172aed21908d2651864eda1e78f13f18fc16))
- **daemon:** keep session ids stable across restore
  ([#148](https://github.com/zgeoff/atc/issues/148))
  ([1bfd3cc](https://github.com/zgeoff/atc/commit/1bfd3ccd62270aadf1e9c26f9a1da0c8ffecff86))
- **daemon:** limit each principal to the targets it may use
  ([#162](https://github.com/zgeoff/atc/issues/162))
  ([9aaad43](https://github.com/zgeoff/atc/commit/9aaad438218be5de052d0a5b9fe34e908b6277e2))
- **daemon:** make session.message idempotent under a key
  ([#158](https://github.com/zgeoff/atc/issues/158))
  ([8f38190](https://github.com/zgeoff/atc/commit/8f38190ab9aed7ddb45247b3cbd3794a41d8d2c9))
- **daemon:** make session.spawn idempotent under a key
  ([#157](https://github.com/zgeoff/atc/issues/157))
  ([92f8642](https://github.com/zgeoff/atc/commit/92f8642f8f80988e92b49b8f7f8e0e0ee218d065))
- **daemon:** run each session on an explicit execution target
  ([#160](https://github.com/zgeoff/atc/issues/160))
  ([147b3f6](https://github.com/zgeoff/atc/commit/147b3f6ed9d1f874d29a87e551783de57c4af31b))
- **daemon:** run session harnesses through an execution provider
  ([#159](https://github.com/zgeoff/atc/issues/159))
  ([9f8844a](https://github.com/zgeoff/atc/commit/9f8844a09ecbd3980ec0f43a68aa511515953110))
- **workspace:** add clean-checkout resolution, clone, and sanitize
  ([#150](https://github.com/zgeoff/atc/issues/150))
  ([ff97162](https://github.com/zgeoff/atc/commit/ff97162b3ca22606355b0140b40c661f5fa18a48))

## [2.11.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.10.4...@zgeoff/atc@2.11.0) (2026-10-03)

### Features

- **mcp:** add message waits, structured results, and agents list
  ([#143](https://github.com/zgeoff/atc/issues/143))
  ([f40b4a6](https://github.com/zgeoff/atc/commit/f40b4a61f5a45054480d29239de24d596f411d6b))

## [2.10.4](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.10.3...@zgeoff/atc@2.10.4) (2026-10-03)

### Bug Fixes

- **grants:** revoke grants whose id starts with a dash
  ([#156](https://github.com/zgeoff/atc/issues/156))
  ([38d668f](https://github.com/zgeoff/atc/commit/38d668fb9cee306884f4aac70aed66546732f9f0))

## [2.10.3](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.10.2...@zgeoff/atc@2.10.3) (2026-10-03)

### Bug Fixes

- **agents:** keep test runs out of the real state directory
  ([#151](https://github.com/zgeoff/atc/issues/151))
  ([986fb9d](https://github.com/zgeoff/atc/commit/986fb9de459df0af630e2c01eb43c2e423d94070))

## [2.10.2](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.10.1...@zgeoff/atc@2.10.2) (2026-10-02)

### Bug Fixes

- **daemon:** admit one daemon per state directory
  ([#142](https://github.com/zgeoff/atc/issues/142))
  ([e849f39](https://github.com/zgeoff/atc/commit/e849f39997980b89e772ede9c70e01a825689f2b))

## [2.10.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.10.0...@zgeoff/atc@2.10.1) (2026-10-02)

### Bug Fixes

- **#137:** load the agent sdk lazily and give the tui boot its own wait
  ([#141](https://github.com/zgeoff/atc/issues/141))
  ([989ba4f](https://github.com/zgeoff/atc/commit/989ba4f8626b4733c8cbae51f1662f4b66d957ad))

## [2.10.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.9.0...@zgeoff/atc@2.10.0) (2026-10-02)

### Features

- **mcp:** declare safety annotations and scopes on every tool
  ([#128](https://github.com/zgeoff/atc/issues/128))
  ([4c7aad1](https://github.com/zgeoff/atc/commit/4c7aad17b883a9b40f46c6057eb23f0a95afa96b))
- **mcp:** serve mcp over http with better-auth as the oauth server
  ([#135](https://github.com/zgeoff/atc/issues/135))
  ([f9223a1](https://github.com/zgeoff/atc/commit/f9223a16a92cffb43dae7d3a0533f7430a0767ae))

### Bug Fixes

- **daemon:** record headless turns in the trail and keep their result
  ([#129](https://github.com/zgeoff/atc/issues/129))
  ([af8f122](https://github.com/zgeoff/atc/commit/af8f122b34a5748284f958973100edbedc9182f1))

## [2.9.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.8.2...@zgeoff/atc@2.9.0) (2026-10-02)

### Features

- **daemon:** record message and report events in the event trail
  ([#127](https://github.com/zgeoff/atc/issues/127))
  ([bf62eb0](https://github.com/zgeoff/atc/commit/bf62eb031354e2d556456917ddd683b94988f6fd))

## [2.8.2](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.8.1...@zgeoff/atc@2.8.2) (2026-10-02)

### Bug Fixes

- **client:** reject a request sent after the connection closed
  ([#123](https://github.com/zgeoff/atc/issues/123))
  ([4068cd9](https://github.com/zgeoff/atc/commit/4068cd9ee1b89ba13a05fa9ca04895b850047124))

## [2.8.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.8.0...@zgeoff/atc@2.8.1) (2026-10-02)

### Bug Fixes

- steer agents to report milestones and follow messages by id
  ([#121](https://github.com/zgeoff/atc/issues/121))
  ([0f4ec34](https://github.com/zgeoff/atc/commit/0f4ec34e21d562e1f9dd2afa6ec5657c09f00686))

## [2.8.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.7.0...@zgeoff/atc@2.8.0) (2026-10-02)

### Features

- **agents:** load an atc mod into every claude session
  ([#111](https://github.com/zgeoff/atc/issues/111))
  ([bfd9923](https://github.com/zgeoff/atc/commit/bfd99237ad8fbad605774f1b9ea5678d8488d468))

### Bug Fixes

- **daemon:** end every client connection when the daemon stops
  ([#118](https://github.com/zgeoff/atc/issues/118))
  ([2c5e603](https://github.com/zgeoff/atc/commit/2c5e603f8cf194845e97851f341366a2c7e79059))

## [2.7.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.6.0...@zgeoff/atc@2.7.0) (2026-10-02)

### Features

- **daemon:** add a message inbox per session ([#108](https://github.com/zgeoff/atc/issues/108))
  ([08bd84a](https://github.com/zgeoff/atc/commit/08bd84aceae89ab37e8db5138c79cd47bb7d05d4))

## [2.6.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.5.1...@zgeoff/atc@2.6.0) (2026-10-02)

### Features

- **daemon:** add cursor reads for session state, transcripts and events
  ([#109](https://github.com/zgeoff/atc/issues/109))
  ([eaa7239](https://github.com/zgeoff/atc/commit/eaa7239bb922992497a6060267056b44af6fa6ad))

## [2.5.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.5.0...@zgeoff/atc@2.5.1) (2026-10-02)

### Bug Fixes

- **deps:** pin fast-uri, ip-address and brace-expansion past advisories
  ([#110](https://github.com/zgeoff/atc/issues/110))
  ([96b93b0](https://github.com/zgeoff/atc/commit/96b93b0c9f8e8d48ad3a8833a9a58cc09cbe15a4))

## [2.5.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.4.1...@zgeoff/atc@2.5.0) (2026-09-25)

### Features

- move atc's own testing rules into a project skill ([#97](https://github.com/zgeoff/atc/issues/97))
  ([6e3f609](https://github.com/zgeoff/atc/commit/6e3f609a827da9d54b1a5f94a9334cd774a56cd3))

## [2.4.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.4.0...@zgeoff/atc@2.4.1) (2026-09-18)

### Bug Fixes

- **client:** treat an empty .git directory as no repository
  ([#93](https://github.com/zgeoff/atc/issues/93))
  ([a587db6](https://github.com/zgeoff/atc/commit/a587db6b45292b4692a72154be0827f73fe2f70b))

## [2.4.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.3.1...@zgeoff/atc@2.4.0) (2026-09-18)

### Features

- **config:** start a gateway's sessions with settings of their own
  ([#89](https://github.com/zgeoff/atc/issues/89))
  ([a897a9b](https://github.com/zgeoff/atc/commit/a897a9b0890aed04c6a4212b45c4f0fd714c97e9))

## [2.3.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.3.0...@zgeoff/atc@2.3.1) (2026-09-18)

### Bug Fixes

- **deps:** pin past the hono and js-yaml advisories
  ([#90](https://github.com/zgeoff/atc/issues/90))
  ([15323e1](https://github.com/zgeoff/atc/commit/15323e1eba0728d8835e8e98724909500a1ca4c7))

## [2.3.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.2.1...@zgeoff/atc@2.3.0) (2026-09-08)

### Features

- **client:** pick a directory without zoxide ([#85](https://github.com/zgeoff/atc/issues/85))
  ([dc9379a](https://github.com/zgeoff/atc/commit/dc9379ae45fa84478bccd973fa826c3e3474acbf))
- **release:** ship compiled binaries so atc runs without a bun install
  ([#87](https://github.com/zgeoff/atc/issues/87))
  ([1f03166](https://github.com/zgeoff/atc/commit/1f03166aaa38a6aad0b3d14d4c2758667d77eb97))

## [2.2.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.2.0...@zgeoff/atc@2.2.1) (2026-09-04)

### Bug Fixes

- **tui:** show the tail of the picker input when it outgrows the row
  ([#80](https://github.com/zgeoff/atc/issues/80))
  ([18db2c6](https://github.com/zgeoff/atc/commit/18db2c61f6a4a7587c33696f54dffa66d41a6143))

## [2.2.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.1.0...@zgeoff/atc@2.2.0) (2026-09-03)

### Features

- nest sub-sessions under the session that spawned them
  ([#77](https://github.com/zgeoff/atc/issues/77))
  ([080b737](https://github.com/zgeoff/atc/commit/080b7379467b4edfc9a62c0a5565b357f21072ca))

## [2.1.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@2.0.0...@zgeoff/atc@2.1.0) (2026-09-03)

### Features

- read a session screen as plain text over the protocol and mcp
  ([#73](https://github.com/zgeoff/atc/issues/73))
  ([5b6e01d](https://github.com/zgeoff/atc/commit/5b6e01d70db18f24083f8a30018d0e27b8338ef0))

## [2.0.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@1.0.3...@zgeoff/atc@2.0.0) (2026-09-01)

### ⚠ BREAKING CHANGES

- every wire event name changes and PROTOCOL_V is now 3; restart a running daemon after upgrading.

### Features

- broadcast session attached and detached events ([#66](https://github.com/zgeoff/atc/issues/66))
  ([8328e49](https://github.com/zgeoff/atc/commit/8328e497b9e3ee4a0cd9da409bb30402b239ea03))
- run user hooks on daemon events ([#68](https://github.com/zgeoff/atc/issues/68))
  ([b826276](https://github.com/zgeoff/atc/commit/b82627627db275954c04cba9a140325d3e003907))
- stream wire events over a read-only events socket ([#69](https://github.com/zgeoff/atc/issues/69))
  ([dfd95dd](https://github.com/zgeoff/atc/commit/dfd95ddc5bd80f84b951f7885e74e043ac51894f))

### Documentation

- rewrite project docs against latest writing guidelines
  ([#71](https://github.com/zgeoff/atc/issues/71))
  ([42274b7](https://github.com/zgeoff/atc/commit/42274b73bb9ec28366f4e684a193eeff537bcba5))

### Code Refactoring

- rename wire events to pascal case ([#65](https://github.com/zgeoff/atc/issues/65))
  ([0f89f2c](https://github.com/zgeoff/atc/commit/0f89f2ccf81fe267a1b8b55099dc5d6b873ba17c))

## [1.0.3](https://github.com/zgeoff/atc/compare/@zgeoff/atc@1.0.2...@zgeoff/atc@1.0.3) (2026-08-25)

### Bug Fixes

- **daemon:** replay only the visible buffer of an alt-screen session
  ([#62](https://github.com/zgeoff/atc/issues/62))
  ([8ed47da](https://github.com/zgeoff/atc/commit/8ed47da5eeb5e478fd14d8373fa4bbf9655d4d19))

## [1.0.2](https://github.com/zgeoff/atc/compare/@zgeoff/atc@1.0.1...@zgeoff/atc@1.0.2) (2026-08-25)

### Bug Fixes

- **daemon:** drain pending screen writes before serializing a replay
  ([#60](https://github.com/zgeoff/atc/issues/60))
  ([b8b2a1d](https://github.com/zgeoff/atc/commit/b8b2a1d83f4ccbd946d9d676afd70ff96c3849ff))

## [1.0.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@1.0.0...@zgeoff/atc@1.0.1) (2026-08-24)

### Bug Fixes

- **tui:** erase vacated box rows and resize before attach replay
  ([#58](https://github.com/zgeoff/atc/issues/58))
  ([b4c4b14](https://github.com/zgeoff/atc/commit/b4c4b141ae0770cd637623206675aee5fd1b8466))

## [1.0.0](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.12...@zgeoff/atc@1.0.0) (2026-08-23)

### Features

- brand SessionID and AgentSessionID types ([#49](https://github.com/zgeoff/atc/issues/49))
  ([d5cf101](https://github.com/zgeoff/atc/commit/d5cf101d7882a04519646ebc014c506c5b7b1355))
- hide uninstalled agents from the spawn picker ([#37](https://github.com/zgeoff/atc/issues/37))
  ([b0b94b7](https://github.com/zgeoff/atc/commit/b0b94b7ebe4897e64697fca4f8ff03ef65a5a482))
- keep a headless turn on its session's backend ([#44](https://github.com/zgeoff/atc/issues/44))
  ([448690a](https://github.com/zgeoff/atc/commit/448690acfba87d980111f42f357f97d92798b151))
- spawn a configured backend as its own agent ([#43](https://github.com/zgeoff/atc/issues/43))
  ([1bddfff](https://github.com/zgeoff/atc/commit/1bddfff60157bc362ee84a402471696c552b1ad4))

### Bug Fixes

- correct structural defects found in the architecture audit
  ([#40](https://github.com/zgeoff/atc/issues/40))
  ([f529d91](https://github.com/zgeoff/atc/commit/f529d91357840673115c63936e1d4aa8fffda5a1))

### Miscellaneous Chores

- drop the pre-1.0 version bump rules ([#57](https://github.com/zgeoff/atc/issues/57))
  ([70c08b9](https://github.com/zgeoff/atc/commit/70c08b9e1174dbe0b3dd6b23959adebb812e9cd9))

## [0.1.12](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.11...@zgeoff/atc@0.1.12) (2026-08-21)

### Features

- retain killed sessions across daemon restarts ([#35](https://github.com/zgeoff/atc/issues/35))
  ([e938a7e](https://github.com/zgeoff/atc/commit/e938a7ee1b8383019b2038c623a830281a64a26a))

## [0.1.11](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.10...@zgeoff/atc@0.1.11) (2026-08-20)

### Features

- host codex CLI sessions in a mixed fleet ([#31](https://github.com/zgeoff/atc/issues/31))
  ([d24a106](https://github.com/zgeoff/atc/commit/d24a106c18c3b679dee79f86b49e53a9e6c91edb))

## [0.1.10](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.9...@zgeoff/atc@0.1.10) (2026-08-19)

### Features

- host grok CLI sessions in a mixed fleet ([#24](https://github.com/zgeoff/atc/issues/24))
  ([eac9b9e](https://github.com/zgeoff/atc/commit/eac9b9e9a5cd174415ace22d4d214946c6851da5))

### Bug Fixes

- write the claude settings file on first spawn, not construction
  ([#26](https://github.com/zgeoff/atc/issues/26))
  ([febf231](https://github.com/zgeoff/atc/commit/febf2311c565eb81a111942966f43ddbdba41b02))

## [0.1.9](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.8...@zgeoff/atc@0.1.9) (2026-08-18)

### Features

- replace groups with pinning, attach recency, and a grouping toggle
  ([#22](https://github.com/zgeoff/atc/issues/22))
  ([990609a](https://github.com/zgeoff/atc/commit/990609abb72dbade3a8c31d5a559749591c5b1d1))

## [0.1.8](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.7...@zgeoff/atc@0.1.8) (2026-08-17)

### Bug Fixes

- match leader chords and replay input modes ([#20](https://github.com/zgeoff/atc/issues/20))
  ([e2399aa](https://github.com/zgeoff/atc/commit/e2399aaee478b708b1a5fd101811c02a8abeee90))

## [0.1.7](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.6...@zgeoff/atc@0.1.7) (2026-08-14)

### Features

- tab-jump to the latest finished session when none need you
  ([#18](https://github.com/zgeoff/atc/issues/18))
  ([a25d49d](https://github.com/zgeoff/atc/commit/a25d49d237e5df7e47caf98ee44bdbe5b42edff5))

## [0.1.6](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.5...@zgeoff/atc@0.1.6) (2026-08-14)

### Features

- show restoring sessions up front and revive most recent first
  ([#16](https://github.com/zgeoff/atc/issues/16))
  ([cfad791](https://github.com/zgeoff/atc/commit/cfad791836585bf78a17d7dbd95c78813ad6d2de))

## [0.1.5](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.4...@zgeoff/atc@0.1.5) (2026-08-14)

### Features

- gate fleet restore on each session's SessionStart hook
  ([#14](https://github.com/zgeoff/atc/issues/14))
  ([ad37010](https://github.com/zgeoff/atc/commit/ad370101a4bd69b492a81e3b1e8a8d970e0d5f13))

## [0.1.4](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.3...@zgeoff/atc@0.1.4) (2026-08-13)

### Bug Fixes

- cluster overlay rows by group so headers render once per group
  ([#12](https://github.com/zgeoff/atc/issues/12))
  ([2e9a400](https://github.com/zgeoff/atc/commit/2e9a4001fceeb50d4a71b124fdda801b23de3f5a))

## [0.1.3](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.2...@zgeoff/atc@0.1.3) (2026-08-13)

### Features

- keep a stale daemon in service until a deliberate restart
  ([#10](https://github.com/zgeoff/atc/issues/10))
  ([37f5768](https://github.com/zgeoff/atc/commit/37f57682ea877646071ec4a1339aa27657859cba))

## [0.1.2](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.1...@zgeoff/atc@0.1.2) (2026-08-13)

### Features

- group sessions and let agents organise the fleet ([#8](https://github.com/zgeoff/atc/issues/8))
  ([ae870d7](https://github.com/zgeoff/atc/commit/ae870d783583d5fd577e472221ce302aea8d21b4))
- scale the overlay for large fleets ([#7](https://github.com/zgeoff/atc/issues/7))
  ([d2917ee](https://github.com/zgeoff/atc/commit/d2917ee4b13f9a489a0818bc68a2805d905d1ea0))

## [0.1.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.0...@zgeoff/atc@0.1.1) (2026-08-12)

### Features

- add an on-demand fleet brief
  ([ffe281b](https://github.com/zgeoff/atc/commit/ffe281bb1cb1f189678db4186393516c9ba99b47))
- add the daemon protocol listener with handshake and dispatch
  ([d8d2323](https://github.com/zgeoff/atc/commit/d8d23236963a551ff4cf373b5d61165cc88e092a))
- add the screen tier of the attention detector stack
  ([1021b40](https://github.com/zgeoff/atc/commit/1021b4079355a34b511c97123eca2b820bb077ee))
- add the wire protocol codec and per-client outbound queue
  ([91ae5be](https://github.com/zgeoff/atc/commit/91ae5be172250439dc6440dce96a4504490ab50e))
- adopt citty for cli dispatch
  ([15721dc](https://github.com/zgeoff/atc/commit/15721dcfcf75a3a8236a3edf7872565116863544))
- arbitrate permission requests first-response-wins
  ([39cf6d3](https://github.com/zgeoff/atc/commit/39cf6d377439611c2ecf024692b52e85d6813484))
- expose the fleet as mcp tools
  ([a96d109](https://github.com/zgeoff/atc/commit/a96d1095a6de7fec40ca004fa8f17a8eebcc560b))
- hand sessions off between terminal and headless
  ([d79d6f0](https://github.com/zgeoff/atc/commit/d79d6f08ff2fc00c1677a24fbc608a714149bc2a))
- initial atc MVP
  ([83e11e1](https://github.com/zgeoff/atc/commit/83e11e1b1aa9935f2c225ed86b6336722ee9c98e))
- keep daemon state in sqlite
  ([5747cd8](https://github.com/zgeoff/atc/commit/5747cd840588556682eedde4ec3492c3d996b15e))
- make the overlay leader key configurable ([#6](https://github.com/zgeoff/atc/issues/6))
  ([4c67b53](https://github.com/zgeoff/atc/commit/4c67b5339542031d87bf5f595166f20731e6cb59))
- make the tui a thin client that auto-spawns the daemon
  ([6cccb8f](https://github.com/zgeoff/atc/commit/6cccb8fd57666b1a1dc1bab613da65f067d2752a))
- move session ownership into the daemon
  ([3872e54](https://github.com/zgeoff/atc/commit/3872e544395d0156a8b749e201a26d38acdddb46))
- overlay slash filter and attach-clears-need
  ([224cf34](https://github.com/zgeoff/atc/commit/224cf34b42289d482413d7c9340eeb9a162ccdb9))
- preselect the focused session when the overlay opens
  ([d16631f](https://github.com/zgeoff/atc/commit/d16631f977be7cbe8c372fc7ea474c3d6b01781e))
- publish to npm as @zgeoff/atc via release-please ([#2](https://github.com/zgeoff/atc/issues/2))
  ([9e9ed07](https://github.com/zgeoff/atc/commit/9e9ed07e28fd9839a3ea0714397e8f8e0df6f3d3))
- pull session names from claude transcripts
  ([106c8fd](https://github.com/zgeoff/atc/commit/106c8fdcb050b6e328828484046fa861e1b161fd))
- remove the fleet brief
  ([048fbcc](https://github.com/zgeoff/atc/commit/048fbcc235d0421b3cb880a6d0583ad4caa267b8))
- replace the attach jiggle with a headless screen model
  ([7e78d94](https://github.com/zgeoff/atc/commit/7e78d941dfc71adbde318f6b5f43b8fc69a9730d))
- revive a killed session from the overlay
  ([ea40c1d](https://github.com/zgeoff/atc/commit/ea40c1d5cfacd721e3deb5deeeaf8c5770ff85ec))
- show only the selected session's actions in the overlay hints
  ([bd53ca3](https://github.com/zgeoff/atc/commit/bd53ca39d05879a827277965b52068b1b0e709eb))
- stream sessions to attached clients with input and resize
  ([5d4b948](https://github.com/zgeoff/atc/commit/5d4b9480e426425cffd6e831ae94e5246a859faf))

### Bug Fixes

- carry alive and kind on session.state so the client stops guessing
  ([d7db6e9](https://github.com/zgeoff/atc/commit/d7db6e9eda53770276ba0977d19619f3d04098fd))
- guard revive and eject on a saved transcript and surface failures
  ([c15d6f3](https://github.com/zgeoff/atc/commit/c15d6f3af604384a2066306f6ad2d235fd9b0365))
- harden the mcp test client against short writes and any leaks
  ([882c473](https://github.com/zgeoff/atc/commit/882c4737b87fbde7021234c4b703dfa8122fce9c))
- keep spawned claudes out of any enclosing claude session
  ([e5ae5cb](https://github.com/zgeoff/atc/commit/e5ae5cb6eb2e777b6909088c6005873ff3e29dc2))
- move the daemon pid file beside its sockets, compare fresh builds
  ([72cd37c](https://github.com/zgeoff/atc/commit/72cd37cdf246dd1b7d8c065321182e433d2047aa))
- point release automation at the componentful release-please branch
  ([#4](https://github.com/zgeoff/atc/issues/4))
  ([512466d](https://github.com/zgeoff/atc/commit/512466d2471561fd57689814a0c60f149fdad7f8))
- restart a daemon left running from an older build
  ([355dc64](https://github.com/zgeoff/atc/commit/355dc64187eaa3f536cf113ce7e5fff5e2cf9ef7))
- stamp the build identity with the entry file mtime
  ([ed1ba7c](https://github.com/zgeoff/atc/commit/ed1ba7cb17d28821ee81c3e11f952d8a99a9e09d))
- stamp the build with the newest source mtime, not one entry file
  ([b24786f](https://github.com/zgeoff/atc/commit/b24786fcdb5ba8fc0118f40f0b262d6c0ab779bd))
- stateful decode on the stdin to pty path
  ([9465854](https://github.com/zgeoff/atc/commit/9465854933c33780a825857511eab9dc57556171))
